/* =========================================================================
   Steal a Dragon Egg — cosmetics Shop panel (panel 'shop', SE.ShopUI)

   SPEC §7 / §8 / §10. Registers SE.UI.registerPanel('shop', …) as soon as
   SE.UI exists (retries until js/ui/core.js has loaded).

   Layout (decided from the panel body's own size, not the viewport):
     landscape — preview stage + action button on the left, gem tabs + grid on
                 the right;  portrait — compact preview on top, tabs, grid.
     The grid scrolls inside the panel; the panel itself never scrolls.
   Preview stage: one private THREE.WebGLRenderer (alpha, sRGB output, ACES
     Filmic like SPEC §13), created on the first open and reused; the render
     loop runs only while the panel is open, visible and no ad is playing.
     Drag to rotate (inertia), auto-rotate after 2.5 s. Falls back to the item
     thumbnail when WebGL is unavailable or the context is lost.
     The object from SE.Cosmetics.previewObject(id, equipped) is cached (LRU 6);
     when it has userData.update(dt, time) the stage calls it every frame;
     evicted objects are released with SE.Cosmetics.disposePreview(obj) when that
     exists (otherwise userData.dispose()), never disposed blindly.
   Tabs: SE.CosmeticData.TABS — Outfits, Hats, Back, Trails, Victory and the 6th 'mythic' tab
     (full-body GLB skins: slot 'outfit', item.shopTab 'mythic', animated rainbow frame + MYTHIC
     badge; a "soon" placeholder card / stage crystal while the model is missing; Unequip returns
     to the previous outfit, stored as SE.State.data.cosPrevOutfit).
   Purchases: gems → SE.State.spendGems + grantItem; ads → SE.Ads.rewarded(
     'shop-unlock', onGranted, onDone) (fallback SE.Platform.showRewarded) →
     SE.State.addAdView(id) → grantItem when views ≥ price.ads. Every change is
     saved with SE.State.save(). Equip → SE.State.equipItem + SE.Cosmetics.apply(
     SE.Player.model, equipped). Double-click guard on every action; a spinner
     while an ad is running. Exclusive items are hidden unless already owned
     (owned exclusives stay visible so they can be re-equipped).
   "New" dots: owned items not yet looked at in the shop (e.g. won on the wheel
     or from the Daily Gift); stored as SE.State.data.shopSeen = { id: 1 }.

   Public API
     SE.ShopUI.open([tab], [itemId])   → SE.UI.open('shop', { tab, item })
       (SE.UI.open('shop', { tab:'hat', item:'hat_crown' }) works the same)
     SE.ShopUI.newCount() -> number    owned-but-unseen items (HUD Shop badge)
     SE.ShopUI.refresh()               re-sync an open shop with SE.State
     SE.ShopUI.select(itemId)          select an item (switches tab)
     SE.ShopUI.dispose()               release the preview renderer (it is
                                       re-created on the next open)
     SE.ShopUI.info() -> { open, tab, selected, adPending, webgl }  (QA)
   Depends on: SE.UI, SE.State, SE.CosmeticData, SE.Cosmetics, SE.Ads /
   SE.Platform, SE.I18N; optional SE.Audio, SE.Player, SE.DragonData.
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var doc = global.document;

  /* Game root (folder of index.html), derived from this script's URL so the
     dev lab in game/dev/ resolves the same image paths as the game. */
  var ROOT = (function () {
    try {
      var src = doc.currentScript && doc.currentScript.src;
      var m = src && /^(.*\/)js\/ui\/shop\.js(?:[?#].*)?$/.exec(src);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  })();
  function asset(p) { return ROOT + p; }

  var THUMB = 160;
  var TAB_ORDER = ['outfit', 'hat', 'back', 'trail', 'victory'];
  /* Gem-cut tab colours (emerald, topaz, sapphire, amethyst, ruby) + icons. */
  var TAB_STYLE = {
    outfit:  { icon: 'assets/ui/shield.png',        c1: '#7fe08a', c2: '#27a24f', c3: '#0d5a2b' },
    hat:     { icon: 'assets/ui/render/crown.png',  c1: '#ffe07a', c2: '#e79b12', c3: '#8a4f05' },
    back:    { icon: 'assets/ui/bag.png',           c1: '#8fd0ff', c2: '#2f78dc', c3: '#14408a' },
    trail:   { icon: 'assets/ui/trail-rainbow.png', c1: '#dcaeff', c2: '#8d4ae2', c3: '#4a1c8e' },
    victory: { icon: 'assets/ui/trophy.png',        c1: '#ff9a9a', c2: '#df3a4e', c3: '#8a1426' },
    mythic:  { icon: 'assets/ui/sparkles.png',      c1: '#ffb3e6', c2: '#ff3fb4', c3: '#8a1a6a' }
  };
  var RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };
  var RARITY_COLOR = { common: '#4f9a2a', uncommon: '#2f8a4a', rare: '#d0781a', epic: '#7b3fd0', legendary: '#e0a400', mythic: '#ff3fb4' };
  /* Camera framing per slot: centre (fraction of the height) and the visible height fraction. */
  var FRAMING = {
    outfit:  { cy: 0.50, fit: 1.18, yaw: 0.45 },
    hat:     { cy: 0.80, fit: 0.62, yaw: 0.35 },
    back:    { cy: 0.58, fit: 1.00, yaw: Math.PI + 0.55 },
    trail:   { cy: 0.48, fit: 1.25, yaw: 1.2 },
    victory: { cy: 0.52, fit: 1.30, yaw: 0.3 }
  };
  var IMG = {
    gem: 'assets/ui/render/gem.png',
    lock: 'assets/ui/render/lock.png',
    ad: 'assets/ui/watch-video.png'
  };

  /* ---------------------------------------------------------------------- */
  /* Strings                                                                 */
  /* ---------------------------------------------------------------------- */
  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: {
        'shop.title': 'Магазин',
        'shop.tab.outfit': 'Наряды',
        'shop.tab.hat': 'Шляпы',
        'shop.tab.back': 'На спину',
        'shop.tab.trail': 'Следы',
        'shop.tab.victory': 'Победа',
        'shop.tab.mythic': 'Мифические',
        'shop.buy': 'Купить',
        'shop.get': 'Забрать',
        'shop.free': 'Бесплатно',
        'shop.notEnough': 'Мало самоцветов',
        'shop.needMore': 'Нужно ещё {0} — самоцветы дают за доставку яиц, подарки и колесо',
        'shop.toWheel': 'Колесо',
        'shop.adProgress': 'За рекламу {0}/{1}',
        'shop.adCta': 'За рекламу',
        'shop.adLeft': 'Ещё {0} — и предмет твой!',
        'shop.adLeftOne': 'Последний просмотр — и предмет твой!',
        'shop.adUnavailable': 'Реклама сейчас недоступна',
        'shop.adUnavailableNote': 'Прогресс сохранён — загляни чуть позже.',
        'shop.adPlaying': 'Реклама…',
        'shop.adNotFinished': 'Реклама не досмотрена — просмотр не засчитан',
        'shop.adCounted': 'Просмотр засчитан: {0}/{1}',
        'shop.equip': 'Надеть',
        'shop.equipped': 'Надето',
        'shop.unequip': 'Снять',
        'shop.owned': 'Получено',
        'shop.unlocked': 'Открыто!',
        'shop.bought': 'Куплено!',
        'shop.exclusive': 'Эксклюзив',
        'shop.new': 'Новое',
        'shop.dragHint': 'Крути!',
        'shop.empty': 'Здесь пока пусто',
        'shop.wallet': 'Самоцветы: {0}',
        'shop.preview': 'Примерка',
        'shop.error': 'Не получилось — попробуй ещё раз',
        'shop.rarity.common': 'Обычный',
        'shop.rarity.uncommon': 'Необычный',
        'shop.rarity.rare': 'Редкий',
        'shop.rarity.epic': 'Эпический',
        'shop.rarity.legendary': 'Легендарный',
        'shop.rarity.mythic': 'Мифический',
        'shop.skinNote': 'Полный облик: заменяет наряд. Шапка и предмет на спину — если у облика есть крепления.',
        'shop.skinSoon': 'Модель скоро появится — покупку и прогресс можно сохранить уже сейчас.'
      },
      en: {
        'shop.title': 'Shop',
        'shop.tab.outfit': 'Outfits',
        'shop.tab.hat': 'Hats',
        'shop.tab.back': 'Back',
        'shop.tab.trail': 'Trails',
        'shop.tab.victory': 'Victory',
        'shop.tab.mythic': 'Mythic',
        'shop.buy': 'Buy',
        'shop.get': 'Claim',
        'shop.free': 'Free',
        'shop.notEnough': 'Not enough gems',
        'shop.needMore': '{0} more needed — earn gems by delivering eggs, from gifts and the wheel',
        'shop.toWheel': 'Wheel',
        'shop.adProgress': 'Watch ad {0}/{1}',
        'shop.adCta': 'Watch ad',
        'shop.adLeft': '{0} more and it\'s yours!',
        'shop.adLeftOne': 'One last ad and it\'s yours!',
        'shop.adUnavailable': 'No ad available right now',
        'shop.adUnavailableNote': 'Your progress is saved — try again a bit later.',
        'shop.adPlaying': 'Ad playing…',
        'shop.adNotFinished': 'The ad wasn\'t finished — no progress',
        'shop.adCounted': 'Ad counted: {0}/{1}',
        'shop.equip': 'Equip',
        'shop.equipped': 'Equipped',
        'shop.unequip': 'Unequip',
        'shop.owned': 'Owned',
        'shop.unlocked': 'Unlocked!',
        'shop.bought': 'Purchased!',
        'shop.exclusive': 'Exclusive',
        'shop.new': 'New',
        'shop.dragHint': 'Spin me!',
        'shop.empty': 'Nothing here yet',
        'shop.wallet': 'Gems: {0}',
        'shop.preview': 'Try-on',
        'shop.error': 'Something went wrong — try again',
        'shop.rarity.common': 'Common',
        'shop.rarity.uncommon': 'Uncommon',
        'shop.rarity.rare': 'Rare',
        'shop.rarity.epic': 'Epic',
        'shop.rarity.legendary': 'Legendary',
        'shop.rarity.mythic': 'Mythic',
        'shop.skinNote': 'Full-body skin: replaces your outfit. Hats and back items show where the skin has mounts.',
        'shop.skinSoon': 'The model is on its way — you can already unlock it and keep your progress.'
      },
      tr: {
        'shop.title': 'Mağaza',
        'shop.tab.outfit': 'Kıyafet',
        'shop.tab.hat': 'Şapka',
        'shop.tab.back': 'Sırt',
        'shop.tab.trail': 'İz',
        'shop.tab.victory': 'Zafer',
        'shop.tab.mythic': 'Mitik',
        'shop.buy': 'Satın al',
        'shop.get': 'Al',
        'shop.free': 'Ücretsiz',
        'shop.notEnough': 'Mücevher yetmiyor',
        'shop.needMore': '{0} daha gerekli — mücevherler yumurta teslimatından, hediyelerden ve çarktan gelir',
        'shop.toWheel': 'Çark',
        'shop.adProgress': 'Reklam izle {0}/{1}',
        'shop.adCta': 'Reklam izle',
        'shop.adLeft': '{0} reklam daha ve senin!',
        'shop.adLeftOne': 'Son bir reklam ve senin!',
        'shop.adUnavailable': 'Şu anda reklam yok',
        'shop.adUnavailableNote': 'İlerlemen kaydedildi — biraz sonra tekrar dene.',
        'shop.adPlaying': 'Reklam oynuyor…',
        'shop.adNotFinished': 'Reklam bitmedi — ilerleme sayılmadı',
        'shop.adCounted': 'Reklam sayıldı: {0}/{1}',
        'shop.equip': 'Kuşan',
        'shop.equipped': 'Kuşanıldı',
        'shop.unequip': 'Çıkar',
        'shop.owned': 'Sende var',
        'shop.unlocked': 'Açıldı!',
        'shop.bought': 'Satın alındı!',
        'shop.exclusive': 'Özel',
        'shop.new': 'Yeni',
        'shop.dragHint': 'Döndür!',
        'shop.empty': 'Burada henüz bir şey yok',
        'shop.wallet': 'Mücevher: {0}',
        'shop.preview': 'Deneme',
        'shop.error': 'Olmadı — tekrar dene',
        'shop.rarity.common': 'Yaygın',
        'shop.rarity.uncommon': 'Sıradışı',
        'shop.rarity.rare': 'Nadir',
        'shop.rarity.epic': 'Epik',
        'shop.rarity.legendary': 'Efsanevi',
        'shop.rarity.mythic': 'Mitik',
        'shop.skinNote': 'Tam görünüm: kıyafetinin yerine geçer. Şapka ve sırt eşyası, görünümde bağlantı noktası varsa görünür.',
        'shop.skinSoon': 'Model yakında geliyor — şimdiden açabilir ve ilerlemeni saklayabilirsin.'
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Small helpers                                                           */
  /* ---------------------------------------------------------------------- */
  function t(key) { return SE.t ? SE.t.apply(null, arguments) : key; }
  function lang() { return (SE.I18N && SE.I18N.lang) || 'en'; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function now() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function fmt(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    var s = String(n), out = '';
    while (s.length > 3) { out = ' ' + s.slice(-3) + out; s = s.slice(0, -3); }
    return s + out;
  }
  function sfx(key, opts) {
    try { if (SE.Audio && typeof SE.Audio.play === 'function') SE.Audio.play(key, opts || {}); } catch (e) { /* audio is optional */ }
  }
  function toast(text, type) {
    try { if (SE.UI && typeof SE.UI.toast === 'function') SE.UI.toast(text, type || 'info'); } catch (e) { /* optional */ }
  }
  function shade(hex, f) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex;
    var v = parseInt(m[1], 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255;
    function ch(c) { return Math.max(0, Math.min(255, Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f))); }
    return '#' + ((1 << 24) | (ch(r) << 16) | (ch(g) << 8) | ch(b)).toString(16).slice(1);
  }
  function rarityColor(r) {
    var D = SE.DragonData;
    if (D && D.RARITIES && D.RARITIES[r] && D.RARITIES[r].color) return D.RARITIES[r].color;
    return RARITY_COLOR[r] || RARITY_COLOR.common;
  }
  function rarityName(r) {
    var C = SE.CosmeticData;
    if (C && typeof C.rarityName === 'function') { var n = C.rarityName(r); if (n) return n; }
    return t('shop.rarity.' + (RARITY_ORDER[r] !== undefined ? r : 'common'));
  }

  /* ---------------------------------------------------------------------- */
  /* Data access (all defensive: other modules may still be loading)         */
  /* ---------------------------------------------------------------------- */
  function CD() { return SE.CosmeticData || null; }
  function S() { return SE.State || null; }
  function sdata() { return SE.State && SE.State.data ? SE.State.data : null; }

  function tabIds() {
    var C = CD(), ids = [];
    if (C && Array.isArray(C.TABS)) C.TABS.forEach(function (tb) { if (tb && tb.id && ids.indexOf(tb.id) < 0) ids.push(tb.id); });
    return ids.length ? ids : TAB_ORDER.slice();
  }
  function tabDef(id) {
    var C = CD();
    if (C && Array.isArray(C.TABS)) for (var i = 0; i < C.TABS.length; i++) if (C.TABS[i] && C.TABS[i].id === id) return C.TABS[i];
    return { id: id };
  }
  function tabStyle(id) {
    if (TAB_STYLE[id]) return TAB_STYLE[id];
    var d = tabDef(id);
    return { icon: d.icon ? (/[./]/.test(d.icon) ? d.icon : 'assets/ui/' + d.icon + '.png') : 'assets/ui/star.png', c1: '#ffe07a', c2: '#e79b12', c3: '#8a4f05' };
  }
  function tabName(id) {
    return SE.I18N && SE.I18N.has && !SE.I18N.has('shop.tab.' + id) && tabDef(id).names ? (tabDef(id).names[lang()] || tabDef(id).names.en || id) : t('shop.tab.' + id);
  }
  function getItem(id) {
    var C = CD();
    if (!C || !id) return null;
    try {
      if (typeof C.item === 'function') return C.item(id) || null;
    } catch (e) { return null; }
    var list = C.ITEMS || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function itemName(it) {
    if (!it) return '';
    var C = CD();
    try { if (C && typeof C.name === 'function') { var n = C.name(it.id); if (n) return n; } } catch (e) { /* fall through */ }
    var names = it.names || {};
    return names[lang()] || names.en || it.id;
  }
  function priceOf(it) {
    var p = (it && it.price) || {};
    if (Number(p.gems) > 0) return { kind: 'gems', n: Math.ceil(Number(p.gems)) };
    if (Number(p.ads) > 0) return { kind: 'ads', n: Math.max(1, Math.floor(Number(p.ads))) };
    return { kind: 'free', n: 0 };
  }
  function owns(id) { var s = S(); try { return !!(s && s.owns && s.owns(id)); } catch (e) { return false; } }
  function equippedMap() { var d = sdata(); return (d && d.cosmetics && d.cosmetics.equipped) || {}; }
  function isEquipped(it) { return !!it && equippedMap()[it.tab] === it.id; }
  /* shop tab of an item (mythic skins live in the 'mythic' tab but equip into the 'outfit' slot) */
  function stab(it) { return (it && (it.shopTab || it.tab)) || 'outfit'; }
  function gems() { var d = sdata(); return d ? Math.max(0, Math.floor(d.gems || 0)) : 0; }
  function adViews(id) { var s = S(); try { return s && s.adViews ? s.adViews(id) : 0; } catch (e) { return 0; } }
  function itemState(it) { return !owns(it.id) ? 'locked' : (isEquipped(it) ? 'equipped' : 'owned'); }
  function visible(it) { return !!it && (!it.exclusive || owns(it.id)); }

  /* Shop list: SE.CosmeticData.shopItems(tab) (no exclusives, sorted by rarity then price).
     Daily-Gift exclusives are never sold; once OWNED they are listed first (gold "Exclusive"
     ribbon) so the player can re-equip them — the shop is the only wardrobe. */
  var listCache = {};
  function itemsOf(tab) {
    var C = CD(), list = [];
    if (!C) return list;
    try {
      if (typeof C.shopItems === 'function') list = (C.shopItems(tab) || []).slice();
      else list = (typeof C.byTab === 'function' ? C.byTab(tab) : (C.ITEMS || []).filter(function (it) { return it.tab === tab; })).filter(function (it) { return !it.exclusive; });
      var ex = (typeof C.byTab === 'function' ? C.byTab(tab) : C.ITEMS || []).filter(function (it) { return stab(it) === tab && it.exclusive && owns(it.id); });
      list = ex.concat(list);
    } catch (e) { list = []; }
    if (list.length && !(typeof C.shopItems === 'function')) {
      list.sort(function (a, b) {
        if (!!a.exclusive !== !!b.exclusive) return a.exclusive ? -1 : 1;
        var ra = RARITY_ORDER[a.rarity] || 0, rb = RARITY_ORDER[b.rarity] || 0;
        if (ra !== rb) return ra - rb;
        var pa = priceOf(a), pb = priceOf(b);
        return (pa.kind === 'ads' ? pa.n * 50 : pa.n) - (pb.kind === 'ads' ? pb.n * 50 : pb.n);
      });
    }
    listCache[tab] = list;
    return list;
  }
  function tabCounts(tab) {
    var list = itemsOf(tab), own = 0, fresh = 0;
    list.forEach(function (it) { if (owns(it.id)) { own++; if (!seen(it.id)) fresh++; } });
    return { owned: own, total: list.length, fresh: fresh };
  }

  /* "seen" bookkeeping for the new dots (top-level extra key kept by SE.State.migrate). */
  function seenMap() {
    var d = sdata();
    if (!d) return null;
    if (!d.shopSeen || typeof d.shopSeen !== 'object' || Array.isArray(d.shopSeen)) {
      d.shopSeen = {};
      var owned = (d.cosmetics && d.cosmetics.owned) || {};
      for (var id in owned) if (hasOwn(owned, id) && owned[id] === true) d.shopSeen[id] = 1;
    }
    return d.shopSeen;
  }
  function seen(id) { var m = seenMap(); return !m || m[id] === 1; }
  function markSeen(id) {
    var m = seenMap();
    if (!m || m[id] === 1 || !owns(id)) return false;
    m[id] = 1;
    return true;
  }

  function saveState() {
    var s = S();
    try { if (s && typeof s.save === 'function') return s.save(); } catch (e) { console.error('[shop] save failed', e); }
    return null;
  }
  function applyToPlayer() {
    try {
      var model = SE.Player && SE.Player.model;
      if (model && SE.Cosmetics && typeof SE.Cosmetics.apply === 'function') SE.Cosmetics.apply(model, equippedMap());
    } catch (e) { console.error('[shop] Cosmetics.apply failed', e); }
  }
  function hudUpdate() { try { if (SE.UI && typeof SE.UI.updateHUD === 'function') SE.UI.updateHUD(); } catch (e) { /* optional */ } }

  function adPlatformBusy() {
    var P = SE.Platform;
    return !!(P && P.adActive) || !!(SE.Ads && SE.Ads.busy);
  }
  function adReady() {
    if (SE.Config && SE.Config.ADS === false) return false;
    try {
      if (SE.Ads && typeof SE.Ads.ready === 'function') return !!SE.Ads.ready('shop-unlock') && !adPlatformBusy();
      return !!(SE.Platform && SE.Platform.canRewarded && SE.Platform.canRewarded()) && !adPlatformBusy();
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------------- */
  /* Module state                                                            */
  /* ---------------------------------------------------------------------- */
  var st = {
    open: false,
    tab: null,
    sel: {},          // tab -> selected item id
    scroll: {},       // tab -> grid scrollTop
    body: null,
    root: null,
    els: {},
    lockUntil: 0,
    adPending: null,
    adToken: 0,
    adReadyLast: null,
    thumbs: {},       // id -> dataURL
    thumbFail: {},
    queue: [],
    active: 0,
    io: null,
    ro: null,
    timer: 0,
    walletShown: null,
    registered: false
  };

  function curTab() {
    var ids = tabIds();
    if (!st.tab || ids.indexOf(st.tab) < 0) st.tab = ids[0];
    return st.tab;
  }
  function selectedItem() {
    var tab = curTab(), list = itemsOf(tab), id = st.sel[tab], i;
    for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    var eq = equippedMap()[tab];
    for (i = 0; i < list.length; i++) if (list[i].id === eq) { st.sel[tab] = eq; return list[i]; }
    if (list.length) { st.sel[tab] = list[0].id; return list[0]; }
    return null;
  }
  function locked(ms) {
    var tnow = now();
    if (tnow < st.lockUntil) return true;
    st.lockUntil = tnow + (ms || 350);
    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* Preview stage (own WebGLRenderer, reused between opens)                 */
  /* ---------------------------------------------------------------------- */
  var Stage = {
    wrap: null, canvas: null, fallback: null,
    renderer: null, scene: null, camera: null, turn: null, holder: null, pedestal: null, glow: null,
    ok: null, lost: false, running: false, raf: 0, last: 0, time: 0,
    w: 0, h: 0, yaw: 0.45, vel: 0, drag: null, idleAt: 0, autoSpeed: 0.55,
    cache: [], current: null, currentKey: '', tab: 'outfit',
    cam: { cy: 3.5, dist: 22, tcy: 3.5, tdist: 22 },
    pop: 1, spin: 0, height: 7,

    element: function () {
      if (this.wrap) return this.wrap;
      var w = this.wrap = el('div', 'shop-stage-gl');
      this.fallback = el('div', 'shop-stage-fallback');
      this.fallback.appendChild(el('img'));
      this.fallback.firstChild.alt = '';
      this.fallback.firstChild.draggable = false;
      w.appendChild(this.fallback);
      this.bindDrag();
      return w;
    },

    ensure: function () {
      if (this.ok !== null) return this.ok;
      this.ok = false;
      var THREE = global.THREE;
      if (!THREE || !doc) return false;
      try {
        var canvas = el('canvas', 'shop-stage-canvas');
        var r = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'default', preserveDrawingBuffer: false });
        r.setClearColor(0x000000, 0);
        r.outputEncoding = THREE.sRGBEncoding;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.08;
        this.renderer = r;
        this.canvas = canvas;
        canvas.addEventListener('webglcontextlost', function (ev) { ev.preventDefault(); Stage.lost = true; Stage.syncFallback(); }, false);
        canvas.addEventListener('webglcontextrestored', function () { Stage.lost = false; Stage.syncFallback(); }, false);
        this.wrap.insertBefore(canvas, this.wrap.firstChild);
        this.buildScene(THREE);
        this.ok = true;
      } catch (e) {
        console.warn('[shop] preview renderer unavailable, using thumbnails', e);
        this.renderer = null;
        this.ok = false;
      }
      this.syncFallback();
      return this.ok;
    },

    buildScene: function (THREE) {
      var scene = this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 400);
      var hemi = new THREE.HemisphereLight('#e4f2ff', '#6b5a3e', 0.95);
      scene.add(hemi);
      var key = new THREE.DirectionalLight('#fff1d6', 1.65);
      key.position.set(6, 12, 10);
      scene.add(key);
      var rim = new THREE.DirectionalLight('#9fd2ff', 1.05);
      rim.position.set(-8, 7, -9);
      scene.add(rim);
      var fill = new THREE.DirectionalLight('#ffd9a8', 0.35);
      fill.position.set(-6, 2, 8);
      scene.add(fill);

      /* Small PMREM environment so metallic gold / crystal items read like in the game. */
      try {
        var pm = new THREE.PMREMGenerator(this.renderer);
        var env = new THREE.Scene();
        var skyMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true });
        var skyGeo = new THREE.SphereGeometry(50, 16, 8);
        var cols = [], pos = skyGeo.attributes.position, c = new THREE.Color(), top = new THREE.Color('#bfe0ff'), mid = new THREE.Color('#fff2d8'), bot = new THREE.Color('#5a4630');
        for (var i = 0; i < pos.count; i++) {
          var y = pos.getY(i) / 50;
          if (y > 0) c.copy(mid).lerp(top, Math.min(1, y * 1.4)); else c.copy(mid).lerp(bot, Math.min(1, -y * 2));
          cols.push(c.r * 0.8, c.g * 0.8, c.b * 0.8);
        }
        skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
        env.add(new THREE.Mesh(skyGeo, skyMat));
        var sun = new THREE.Mesh(new THREE.SphereGeometry(6, 8, 6), new THREE.MeshBasicMaterial({ color: '#fff5e0' }));
        sun.material.color.multiplyScalar(3);
        sun.position.set(25, 30, 20);
        env.add(sun);
        scene.environment = pm.fromScene(env, 0.04).texture;
        pm.dispose();
        skyGeo.dispose(); skyMat.dispose(); sun.geometry.dispose(); sun.material.dispose();
      } catch (e) { /* environment is a nicety */ }

      /* Faceted stone pedestal with a gold rim (built once). */
      var ped = this.pedestal = new THREE.Group();
      var stone = new THREE.MeshStandardMaterial({ color: '#8f8577', roughness: 0.92, metalness: 0, flatShading: true });
      var stoneTop = new THREE.MeshStandardMaterial({ color: '#b5aa98', roughness: 0.85, metalness: 0, flatShading: true });
      var gold = new THREE.MeshStandardMaterial({ color: '#f0b93a', roughness: 0.32, metalness: 0.65, flatShading: true });
      var base = new THREE.Mesh(new THREE.CylinderGeometry(3.15, 3.55, 0.9, 10), stone);
      base.position.y = -0.45;
      var top2 = new THREE.Mesh(new THREE.CylinderGeometry(2.85, 3.0, 0.32, 10), stoneTop);
      top2.position.y = 0.06;
      var rim = new THREE.Mesh(new THREE.TorusGeometry(2.98, 0.11, 4, 20), gold);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.2;
      ped.add(base, top2, rim);
      for (var k = 0; k < 5; k++) {
        var stud = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), gold);
        var a = (k / 5) * Math.PI * 2 + 0.3;
        stud.position.set(Math.cos(a) * 3.38, -0.42, Math.sin(a) * 3.38);
        ped.add(stud);
      }
      ped.position.y = -0.22;
      scene.add(ped);

      /* Soft contact shadow (cheaper than a shadow map and always soft). */
      var cv = doc.createElement('canvas');
      cv.width = cv.height = 64;
      var g = cv.getContext('2d');
      var grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(0,0,0,0.55)');
      grd.addColorStop(0.55, 'rgba(0,0,0,0.25)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      var tex = new THREE.CanvasTexture(cv);
      var shadow = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.0;
      shadow.renderOrder = 1;
      scene.add(shadow);

      this.turn = new THREE.Group();
      this.holder = new THREE.Group();
      this.turn.add(this.holder);
      scene.add(this.turn);
    },

    mount: function (container) {
      var w = this.element();
      if (w.parentNode !== container) container.appendChild(w);
      this.ensure();
      this.resize();
    },

    resize: function () {
      if (!this.wrap) return;
      var w = Math.max(1, Math.round(this.wrap.clientWidth)), h = Math.max(1, Math.round(this.wrap.clientHeight));
      if (!this.renderer || (w === this.w && h === this.h)) return;
      this.w = w; this.h = h;
      var mobile = !!(SE.Platform && SE.Platform.isMobile);
      this.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, mobile ? 1.5 : 2));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.frameCamera(true);
      this.renderOnce();
    },

    syncFallback: function () {
      if (!this.wrap) return;
      var useFallback = !this.ok || this.lost || !this.current;
      this.wrap.classList.toggle('is-fallback', useFallback);
    },

    /* Thumbnail shown when the 3D preview is unavailable (and while it builds). */
    setFallbackImage: function (id) {
      if (!this.fallback) return;
      var img = this.fallback.firstChild;
      var url = id && st.thumbs[id];
      if (url) { if (img.getAttribute('src') !== url) img.src = url; img.style.visibility = 'visible'; }
      else { img.removeAttribute('src'); img.style.visibility = 'hidden'; }
      this.fallback.classList.toggle('is-loading', !url && !!id && !st.thumbFail[id]);
    },

    show: function (it) {
      this.setFallbackImage(it && it.id);
      if (it) requestThumb(it.id, true);
      if (!this.ok || !it) { this.clearCurrent(); this.syncFallback(); return; }
      var eq = equippedMap();
      var key = it.id + '|' + (eq.outfit || '') + '|' + (eq.hat || '') + '|' + (eq.back || '');
      this.tab = it.tab || 'outfit';
      if (key === this.currentKey && this.current) { this.frameCamera(false); return; }
      var obj = this.fromCache(key);
      if (!obj) {
        var C = SE.Cosmetics;
        if (C && typeof C.previewObject === 'function') {
          try { obj = C.previewObject(it.id, eq); } catch (e) { console.error('[shop] previewObject failed', e); obj = null; }
        }
        if (obj) this.toCache(key, obj);
      }
      this.clearCurrent();
      if (obj) {
        this.holder.add(obj);
        this.current = obj;
        this.currentKey = key;
        this.measure(obj);
        this.pop = 0;
      }
      this.frameCamera(!this.running);
      this.syncFallback();
      this.renderOnce();
    },

    clearCurrent: function () {
      if (this.current && this.current.parent) this.current.parent.remove(this.current);
      this.current = null;
      this.currentKey = '';
    },

    fromCache: function (key) {
      for (var i = 0; i < this.cache.length; i++) {
        if (this.cache[i].key === key) { var e = this.cache.splice(i, 1)[0]; this.cache.push(e); return e.obj; }
      }
      return null;
    },
    toCache: function (key, obj) {
      this.cache.push({ key: key, obj: obj });
      while (this.cache.length > 6) {
        var old = this.cache.shift();
        if (old.obj === this.current) { this.cache.push(old); break; }
        this.release(old.obj);
      }
    },
    release: function (obj) {
      try {
        if (obj.parent) obj.parent.remove(obj);
        if (SE.Cosmetics && typeof SE.Cosmetics.disposePreview === 'function') SE.Cosmetics.disposePreview(obj);
        else if (obj.userData && typeof obj.userData.dispose === 'function') obj.userData.dispose();
      } catch (e) { /* never break the shop on a dispose */ }
    },
    flushCache: function () {
      var self = this;
      this.clearCurrent();
      this.cache.splice(0).forEach(function (e) { self.release(e.obj); });
    },

    measure: function (obj) {
      var THREE = global.THREE, h = 7;
      if (obj.userData && Number(obj.userData.height) > 0) h = Number(obj.userData.height);
      else {
        try {
          var box = new THREE.Box3().setFromObject(obj);
          var sy = box.max.y - Math.max(0, box.min.y);
          if (isFinite(sy) && sy > 2 && sy < 20) h = sy;
        } catch (e) { /* keep default */ }
      }
      this.height = h;
    },

    frameCamera: function (snap) {
      if (!this.camera) return;
      var f = FRAMING[this.tab] || FRAMING.outfit, h = this.height || 7;
      var vfov = this.camera.fov * Math.PI / 180, aspect = this.camera.aspect || 1;
      var visH = h * f.fit + 0.8, visW = Math.max(6.6, h * 0.95) * Math.min(1.25, f.fit + 0.15);
      var dist = Math.max((visH / 2) / Math.tan(vfov / 2), (visW / 2) / (Math.tan(vfov / 2) * aspect));
      this.cam.tcy = h * f.cy;
      this.cam.tdist = dist;
      if (snap) { this.cam.cy = this.cam.tcy; this.cam.dist = this.cam.tdist; }
    },

    setFocusYaw: function (tab) {
      var f = FRAMING[tab] || FRAMING.outfit, target = f.yaw;
      /* rotate the shortest way to the slot's showcase angle */
      var d = ((target - this.yaw) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      this.spinTo = this.yaw + d;
      this.idleAt = now() + 2500;
    },

    bindDrag: function () {
      var self = this, w = this.wrap;
      function down(ev) {
        if (ev.button !== undefined && ev.button > 0) return;
        self.drag = { id: ev.pointerId, x: ev.clientX, t: now(), moved: 0 };
        self.vel = 0;
        self.spinTo = null;
        try { w.setPointerCapture(ev.pointerId); } catch (e) { /* ok */ }
        w.classList.add('is-dragging');
        var root = st.root;
        if (root) root.classList.add('shop--dragged');
      }
      function move(ev) {
        var d = self.drag;
        if (!d || d.id !== ev.pointerId) return;
        var dx = ev.clientX - d.x, tt = now(), dt = Math.max(1, tt - d.t) / 1000;
        d.x = ev.clientX; d.t = tt; d.moved += Math.abs(dx);
        var a = dx * 0.012;
        self.yaw += a;
        self.vel = self.vel * 0.4 + (a / dt) * 0.6;
        self.renderOnce();
      }
      function up(ev) {
        var d = self.drag;
        if (!d || d.id !== ev.pointerId) return;
        self.drag = null;
        self.idleAt = now() + 2500;
        if (now() - d.t > 90) self.vel = 0;
        w.classList.remove('is-dragging');
      }
      w.addEventListener('pointerdown', down);
      w.addEventListener('pointermove', move);
      w.addEventListener('pointerup', up);
      w.addEventListener('pointercancel', up);
      w.addEventListener('lostpointercapture', up);
    },

    start: function () {
      if (this.running || !this.ok) return;
      this.running = true;
      this.last = now();
      var self = this;
      this.raf = global.requestAnimationFrame(function loop(ts) { self.frame(ts, loop); });
    },
    stop: function () {
      this.running = false;
      if (this.raf) global.cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.drag = null;
    },

    frame: function (ts, loop) {
      if (!this.running) return;
      this.raf = global.requestAnimationFrame(loop);
      if (!this.wrap || !this.wrap.isConnected) { this.stop(); return; }
      var tnow = now(), dt = Math.min(0.05, Math.max(0, (tnow - this.last) / 1000));
      this.last = tnow;
      if (this.lost || st.adPending || adPlatformBusy()) return;   // the ad covers the screen
      this.time += dt;
      this.step(dt, tnow);
      this.draw();
    },

    step: function (dt, tnow) {
      if (!this.drag) {
        if (this.spinTo !== null && this.spinTo !== undefined) {
          var d = this.spinTo - this.yaw;
          this.yaw += d * Math.min(1, dt * 6);
          if (Math.abs(d) < 0.01) this.spinTo = null;
        } else if (Math.abs(this.vel) > 0.02) {
          this.yaw += this.vel * dt;
          this.vel *= Math.pow(0.04, dt);
        } else if (tnow > this.idleAt) {
          this.yaw += this.autoSpeed * dt;
        }
      }
      if (this.spin > 0) {                       // celebration twirl
        var s = Math.min(this.spin, dt * 9);
        this.yaw += s;
        this.spin -= s;
      }
      this.cam.cy += (this.cam.tcy - this.cam.cy) * Math.min(1, dt * 5);
      this.cam.dist += (this.cam.tdist - this.cam.dist) * Math.min(1, dt * 5);
      if (this.pop < 1) this.pop = Math.min(1, this.pop + dt / 0.38);
      var o = this.current;
      if (o && o.userData && typeof o.userData.update === 'function') {
        try { o.userData.update(dt, this.time); } catch (e) { o.userData.update = null; console.error('[shop] preview update failed', e); }
      }
    },

    draw: function () {
      if (!this.renderer || !this.scene) return;
      this.turn.rotation.y = this.yaw;
      var p = this.pop, s = p >= 1 ? 1 : 1 + (Math.sin(p * Math.PI) * 0.08) - (1 - p) * 0.18;
      var hop = p >= 1 ? 0 : Math.sin(p * Math.PI) * 0.6;
      this.holder.scale.setScalar(s);
      this.holder.position.y = hop;
      var cam = this.camera, elev = 0.16;
      cam.position.set(0, this.cam.cy + Math.sin(elev) * this.cam.dist, Math.cos(elev) * this.cam.dist);
      cam.lookAt(0, this.cam.cy, 0);
      try { this.renderer.render(this.scene, cam); } catch (e) { console.error('[shop] preview render failed', e); this.stop(); }
    },

    renderOnce: function () {
      if (this.ok && !this.running && this.scene && this.w) this.draw();
    },

    celebrate: function () {
      this.spin = Math.PI * 2;
      this.pop = 0;
    },

    dispose: function () {
      this.stop();
      this.flushCache();
      try {
        if (this.scene) {
          this.scene.traverse(function (o) {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
              (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
            }
          });
          if (this.scene.environment) this.scene.environment.dispose();
        }
        if (this.renderer) { this.renderer.dispose(); if (this.renderer.forceContextLoss) this.renderer.forceContextLoss(); }
      } catch (e) { /* ignore */ }
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
      this.renderer = this.scene = this.camera = this.canvas = null;
      this.turn = this.holder = this.pedestal = null;
      this.ok = null; this.w = this.h = 0; this.lost = false;
      this.syncFallback();
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Thumbnails: lazy (IntersectionObserver), 2 at a time, cached per id     */
  /* ---------------------------------------------------------------------- */
  function requestThumb(id, urgent) {
    if (!id || st.thumbs[id] || st.thumbFail[id]) return;
    var C = SE.Cosmetics;
    if (!C || typeof C.thumbnail !== 'function') { st.thumbFail[id] = true; applyThumb(id); return; }
    var i = st.queue.indexOf(id);
    if (i >= 0) { if (!urgent) return; st.queue.splice(i, 1); }
    if (urgent) st.queue.unshift(id); else st.queue.push(id);
    pumpThumbs();
  }
  function pumpThumbs() {
    while (st.active < 2 && st.queue.length) {
      var id = st.queue.shift();
      if (st.thumbs[id] || st.thumbFail[id]) continue;
      st.active++;
      (function (id) {
        var p;
        try { p = Promise.resolve(SE.Cosmetics.thumbnail(id, THUMB)); } catch (e) { p = Promise.reject(e); }
        p.then(function (url) {
          if (typeof url === 'string' && url) {
            st.thumbs[id] = url;
            if (SE.Cosmetics.isPlaceholderThumb && SE.Cosmetics.isPlaceholderThumb(url)) {
              setTimeout(function () { if (st.thumbs[id] === url) { delete st.thumbs[id]; if (st.open) requestThumb(id); } }, 15000);
            }
          } else st.thumbFail[id] = true;
        }, function (err) {
          st.thumbFail[id] = true;
          if (SE.Config && SE.Config.DEBUG) console.warn('[shop] thumbnail failed', id, err);
        }).then(function () {
          st.active--;
          applyThumb(id);
          setTimeout(pumpThumbs, 0);
        });
      })(id);
    }
  }
  function applyThumb(id) {
    if (!st.root) return;
    var card = cardEl(id);
    if (card) fillThumb(card, id);
    var it = selectedItem();
    if (it && it.id === id) Stage.setFallbackImage(id);
  }
  function fillThumb(card, id) {
    var box = card.querySelector('.shop-card-thumb');
    if (!box) return;
    var img = box.querySelector('img');
    if (st.thumbs[id]) {
      if (img.getAttribute('src') !== st.thumbs[id]) img.src = st.thumbs[id];
      box.classList.remove('is-loading', 'is-missing');
    } else if (st.thumbFail[id]) {
      var it = getItem(id);
      img.src = asset(tabStyle(it ? stab(it) : 'outfit').icon);
      box.classList.remove('is-loading');
      box.classList.add('is-missing');
    }
  }
  function cardEl(id) {
    if (!st.els.grid) return null;
    var cards = st.els.grid.children;
    for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('data-id') === id) return cards[i];
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* DOM: build                                                              */
  /* ---------------------------------------------------------------------- */
  function walletHTML() {
    return '<img class="shop-wallet-gem" src="' + esc(asset(IMG.gem)) + '" alt="" draggable="false">' +
      '<b class="shop-wallet-n">' + fmt(gems()) + '</b>';
  }

  function build(body) {
    var root = el('div', 'shop');
    root.setAttribute('data-layout', 'land');
    root.innerHTML =
      '<section class="shop-show">' +
        '<div class="shop-stage">' +
          '<div class="shop-stage-sky"><i class="shop-rays"></i><i class="shop-spot"></i><i class="shop-motes"><b></b><b></b><b></b><b></b><b></b><b></b></i></div>' +
          '<div class="shop-stage-slot"></div>' +
          '<div class="shop-stage-top">' +
            '<span class="shop-rarity"></span>' +
            '<span class="shop-wallet shop-wallet--stage" role="status"></span>' +
          '</div>' +
          '<div class="shop-drag-hint" aria-hidden="true"><i></i><span>' + esc(t('shop.dragHint')) + '</span></div>' +
          '<div class="shop-stage-name"></div>' +
          '<div class="shop-burst" aria-hidden="true"></div>' +
        '</div>' +
        '<div class="shop-actions">' +
          '<div class="shop-act-row"></div>' +
          '<div class="shop-note" aria-live="polite"></div>' +
        '</div>' +
      '</section>' +
      '<section class="shop-browse">' +
        '<div class="shop-bar">' +
          '<div class="shop-tabs" role="tablist"></div>' +
          '<span class="shop-wallet shop-wallet--bar" role="status"></span>' +
        '</div>' +
        '<div class="shop-grid-wrap"><div class="shop-grid" role="listbox"></div></div>' +
      '</section>';
    body.appendChild(root);
    var q = function (s) { return root.querySelector(s); };
    st.root = root;
    st.els = {
      stage: q('.shop-stage'), slot: q('.shop-stage-slot'), rarity: q('.shop-rarity'), name: q('.shop-stage-name'),
      burst: q('.shop-burst'), actRow: q('.shop-act-row'), note: q('.shop-note'), tabs: q('.shop-tabs'),
      grid: q('.shop-grid'), gridWrap: q('.shop-grid-wrap'),
      wallets: [q('.shop-wallet--stage'), q('.shop-wallet--bar')]
    };
    st.els.wallets.forEach(function (w) { w.innerHTML = walletHTML(); w.title = t('shop.wallet', fmt(gems())); });
    st.walletShown = gems();

    /* events (delegated) */
    st.els.tabs.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.shop-tab') : null;
      if (b) setTab(b.getAttribute('data-tab'), true);
    });
    st.els.tabs.addEventListener('keydown', onTabKey);
    st.els.grid.addEventListener('click', function (ev) {
      var c = ev.target.closest ? ev.target.closest('.shop-card') : null;
      if (c) selectId(c.getAttribute('data-id'), true);
    });
    st.els.grid.addEventListener('keydown', onGridKey);
    st.els.actRow.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (b && !b.disabled) runAction(b.getAttribute('data-act'), b);
    });
    st.els.note.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (b) runAction(b.getAttribute('data-act'), b);
    });
    st.els.gridWrap.addEventListener('scroll', function () { st.scroll[curTab()] = st.els.gridWrap.scrollTop; }, { passive: true });

    Stage.mount(st.els.slot);
    observeSize(root);
    renderTabs();
    renderGrid(true);
    renderInfo(true);
  }

  function observeSize(root) {
    if (st.ro) { try { st.ro.disconnect(); } catch (e) { /* ignore */ } st.ro = null; }
    st.layoutSig = '';
    var apply = function () {
      if (!root.isConnected) return;
      var w = root.clientWidth, h = root.clientHeight;
      if (!w || !h) return;
      var land = (w >= 540 && w / h >= 1.08) || (w >= 460 && w / h >= 1.4);   /* + short landscape windows */
      /* mid: not wide enough for two columns and not tall enough for stage + actions + tabs + a card row
         stacked (square / small windows): the stage and the actions share the top row */
      var mid = !land && w >= 380 && h < 560 && w / h > 0.78;
      root.setAttribute('data-layout', land ? 'land' : (mid ? 'mid' : 'port'));
      var size = land ? (h < 330 || w < 700 ? 's' : h < 470 ? 'm' : 'l') : (w < 380 ? 's' : w < 560 ? 'm' : 'l');
      root.setAttribute('data-size', size);
      root.classList.toggle('shop--short', h < 300);
      fitTabs();
      Stage.resize();
      /* a new layout (rotation, resize, tab faces) moves the cards: keep the selected one in view */
      var sig = root.getAttribute('data-layout') + root.getAttribute('data-size') + root.getAttribute('data-tabs') + (h < 300);
      if (sig !== st.layoutSig) {
        st.layoutSig = sig;
        if (global.requestAnimationFrame) global.requestAnimationFrame(function () { if (root.isConnected) scrollSelIntoView(false); });
      }
    };
    apply();
    if (global.ResizeObserver) {
      st.ro = new global.ResizeObserver(function () { apply(); });
      st.ro.observe(root);
      st.ro.observe(st.els.slot);
    } else {
      global.addEventListener('resize', apply);
    }
    st.applySize = apply;
  }

  /* ---------------------------------------------------------------------- */
  /* DOM: tabs                                                               */
  /* ---------------------------------------------------------------------- */
  function renderTabs() {
    if (!st.els.tabs) return;
    var cur = curTab(), html = '';
    tabIds().forEach(function (id) {
      var s = tabStyle(id), c = tabCounts(id), on = id === cur;
      html += '<button type="button" class="shop-tab gem-tab' + (on ? ' is-on on' : '') + '" role="tab" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '"' +
        ' data-tab="' + esc(id) + '" style="--tab-c:' + s.c2 + '" title="' + esc(tabName(id)) + '">' +
        '<span class="gt-face"><img class="gt-ic" src="' + esc(asset(s.icon)) + '" alt="" draggable="false">' +
        '<span class="shop-tab-txt"><span class="shop-tab-label">' + esc(tabName(id)) + '</span>' +
        '<span class="shop-tab-count">' + c.owned + '/' + c.total + '</span></span></span>' +
        (c.fresh ? '<i class="shop-dot" aria-label="' + esc(t('shop.new')) + '"></i>' : '') +
        '</button>';
    });
    st.els.tabs.innerHTML = html;
    fitTabs();
  }
  /* Tab faces, measured live (every language, every width): 'full' icon + name + owned/total → 'label' name +
     count → 'icon' icon over the count → 'scroll' icon tabs (≥ 46 px) in a row that scrolls sideways when
     at least five fit → 'wrap' icon tabs in two rows. */
  var TAB_MODES = ['full', 'label', 'icon'];
  function tabsFit(tabs, mode) {
    for (var i = 0; i < tabs.length; i++) {
      var b = tabs[i], face = b.querySelector('.gt-face'), lbl = b.querySelector('.shop-tab-label'), txt = b.querySelector('.shop-tab-txt');
      if (mode === 'icon' && b.offsetWidth < 46) return false;
      if (mode !== 'icon' && lbl && lbl.scrollWidth > lbl.clientWidth + 1) return false;
      if (txt && txt.scrollWidth > txt.clientWidth + 1) return false;
      if (face && face.scrollWidth > face.clientWidth + 1) return false;
    }
    return true;
  }
  function fitTabs() {
    var root = st.root, bar = st.els && st.els.tabs;
    if (!root || !bar || !root.isConnected || !bar.clientWidth) return;
    var tabs = bar.querySelectorAll('.shop-tab');
    if (!tabs.length) return;
    var mode = '';
    for (var m = 0; m < TAB_MODES.length; m++) {
      root.setAttribute('data-tabs', TAB_MODES[m]);
      if (tabsFit(tabs, TAB_MODES[m])) { mode = TAB_MODES[m]; break; }
    }
    if (!mode) mode = 'wrap';   // never a sideways-scrolling row: all six tabs stay visible (two rows if needed)
    root.setAttribute('data-tabs', mode);
  }
  function onTabKey(ev) {
    var k = ev.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    var ids = tabIds(), i = ids.indexOf(curTab());
    i = (i + (k === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length;
    setTab(ids[i], true);
    var b = st.els.tabs.querySelector('.shop-tab.is-on');
    if (b) b.focus();
    ev.preventDefault();
  }

  function setTab(id, user) {
    if (tabIds().indexOf(id) < 0) return;
    if (id === st.tab && st.els.grid && st.els.grid.children.length) return;
    if (st.els.gridWrap) st.scroll[curTab()] = st.els.gridWrap.scrollTop;
    st.tab = id;
    if (user) sfx('tab');
    renderTabs();
    renderGrid(true);
    renderInfo(true);
    Stage.setFocusYaw(id);
  }

  /* ---------------------------------------------------------------------- */
  /* DOM: grid & cards                                                       */
  /* ---------------------------------------------------------------------- */
  function cardInner(it) {
    var stt = itemState(it), pr = priceOf(it), rc = rarityColor(it.rarity), price = '', badge = '';
    if (stt === 'equipped') {
      price = '<span class="shop-price shop-price--eq">' + esc(t('shop.equipped')) + '</span>';
      badge = '<span class="shop-badge shop-badge--eq" title="' + esc(t('shop.equipped')) + '"></span>';
    } else if (stt === 'owned') {
      price = '<span class="shop-price shop-price--own">' + esc(t('shop.owned')) + '</span>';
      badge = '<span class="shop-badge shop-badge--own" title="' + esc(t('shop.owned')) + '"></span>';
    } else {
      badge = '<span class="shop-badge shop-badge--lock"><img src="' + esc(asset(IMG.lock)) + '" alt="" draggable="false"></span>';
      if (pr.kind === 'gems') {
        price = '<span class="shop-price shop-price--gems' + (gems() < pr.n ? ' is-short' : '') + '"><img src="' + esc(asset(IMG.gem)) + '" alt="" draggable="false"><b>' + fmt(pr.n) + '</b></span>';
      } else if (pr.kind === 'ads') {
        var v = Math.min(pr.n, adViews(it.id)), pips = '';
        for (var i = 0; i < pr.n; i++) pips += '<i' + (i < v ? ' class="on"' : '') + '></i>';
        price = '<span class="shop-price shop-price--ads"><span class="shop-rw-txt">' + esc(t('shop.adProgress', v, pr.n)) + '</span><span class="shop-pips">' + pips + '</span></span>';
      } else {
        price = '<span class="shop-price shop-price--free">' + esc(t('shop.free')) + '</span>';
      }
    }
    return { state: stt, rc: rc, html:
      '<span class="shop-card-frame"></span>' +
      /* the MYTHIC / Exclusive ribbon lives inside the thumbnail (bottom edge): nothing pokes out of the card,
         so the first grid row is never cut by the scroller and the ribbon never meets the lock badge */
      '<span class="shop-card-thumb is-loading"><img alt="" draggable="false">' +
        (it.exclusive ? '<span class="shop-card-excl">' + esc(t('shop.exclusive')) + '</span>' : '') +
        (it.rarity === 'mythic' && !it.exclusive ? '<span class="shop-card-myth">' + esc(t('cos.mythicBadge')) + '</span>' : '') +
      '</span>' +
      badge +
      (stt !== 'locked' && !seen(it.id) ? '<i class="shop-dot"></i>' : '') +
      '<span class="shop-card-name">' + esc(itemName(it)) + '</span>' +
      price };
  }

  function makeCard(it, selId) {
    var c = el('button', 'shop-card');
    c.type = 'button';
    c.setAttribute('role', 'option');
    c.setAttribute('data-id', it.id);
    updateCard(c, it, selId);
    return c;
  }
  function updateCard(c, it, selId) {
    var ci = cardInner(it);
    var keepImg = c.querySelector('.shop-card-thumb img');
    var src = keepImg && keepImg.getAttribute('src');
    c.innerHTML = ci.html;
    c.className = 'shop-card shop-card--' + ci.state + ' shop-r-' + (it.rarity || 'common') + (it.id === selId ? ' is-sel' : '');
    c.style.setProperty('--rc', ci.rc);
    c.style.setProperty('--rc-l', shade(ci.rc, 0.55));
    c.style.setProperty('--rc-d', shade(ci.rc, -0.45));
    c.setAttribute('aria-selected', it.id === selId ? 'true' : 'false');
    c.setAttribute('tabindex', it.id === selId ? '0' : '-1');
    c.setAttribute('aria-label', itemName(it) + ', ' + rarityName(it.rarity));
    if (src) { var img = c.querySelector('.shop-card-thumb img'); img.src = src; }
    fillThumb(c, it.id);
  }

  function renderGrid(resetScroll) {
    var grid = st.els.grid;
    if (!grid) return;
    if (st.io) { try { st.io.disconnect(); } catch (e) { /* ignore */ } st.io = null; }
    var tab = curTab(), list = itemsOf(tab), sel = selectedItem(), selId = sel ? sel.id : null;
    grid.innerHTML = '';
    grid.setAttribute('data-tab', tab);
    if (!list.length) {
      grid.appendChild(el('div', 'shop-empty', esc(t('shop.empty'))));
      return;
    }
    var frag = doc.createDocumentFragment();
    list.forEach(function (it) { frag.appendChild(makeCard(it, selId)); });
    grid.appendChild(frag);
    /* keep only this tab's thumbnails in the queue */
    var ids = list.map(function (it) { return it.id; });
    st.queue = st.queue.filter(function (id) { return ids.indexOf(id) >= 0; });
    if (global.IntersectionObserver) {
      st.io = new global.IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { requestThumb(en.target.getAttribute('data-id')); st.io && st.io.unobserve(en.target); }
        });
      }, { root: st.els.gridWrap, rootMargin: '160px 0px' });
      Array.prototype.forEach.call(grid.children, function (c) { st.io.observe(c); });
    } else {
      ids.forEach(function (id) { requestThumb(id); });
    }
    if (resetScroll && st.els.gridWrap) {
      var top = st.scroll[tab] || 0;
      st.els.gridWrap.scrollTop = top;
      if (!top) scrollSelIntoView(false);
    }
  }

  function refreshCards() {
    var grid = st.els.grid;
    if (!grid) return;
    var sel = selectedItem(), selId = sel ? sel.id : null;
    Array.prototype.forEach.call(grid.children, function (c) {
      var id = c.getAttribute && c.getAttribute('data-id');
      var it = id && getItem(id);
      if (it) updateCard(c, it, selId);
    });
  }

  function scrollSelIntoView(smooth) {
    var sel = selectedItem(), c = sel && cardEl(sel.id), wrap = st.els.gridWrap;
    if (!c || !wrap) return;
    var top = c.offsetTop, bottom = top + c.offsetHeight;
    if (top < wrap.scrollTop + 4) wrap.scrollTo ? wrap.scrollTo({ top: Math.max(0, top - 8), behavior: smooth ? 'smooth' : 'auto' }) : (wrap.scrollTop = top - 8);
    else if (bottom > wrap.scrollTop + wrap.clientHeight - 4) {
      var y = bottom - wrap.clientHeight + 8;
      if (wrap.scrollTo) wrap.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'auto' }); else wrap.scrollTop = y;
    }
  }

  function onGridKey(ev) {
    var k = ev.key, list = itemsOf(curTab()), sel = selectedItem();
    if (!sel || !list.length) return;
    var i = 0;
    for (; i < list.length; i++) if (list[i].id === sel.id) break;
    var cols = 1, g = st.els.grid;
    try { cols = Math.max(1, getComputedStyle(g).gridTemplateColumns.split(' ').length); } catch (e) { cols = 4; }
    var j = i;
    if (k === 'ArrowRight') j = i + 1; else if (k === 'ArrowLeft') j = i - 1;
    else if (k === 'ArrowDown') j = i + cols; else if (k === 'ArrowUp') j = i - cols;
    else if (k === 'Enter' || k === ' ') { ev.preventDefault(); runAction(primaryAct(sel)); return; }
    else return;
    ev.preventDefault();
    j = Math.max(0, Math.min(list.length - 1, j));
    selectId(list[j].id, true);
    var c = cardEl(list[j].id);
    if (c) c.focus();
  }

  function selectId(id, user) {
    var it = getItem(id);
    if (!it || !visible(it)) return;
    var tb = stab(it);
    if (tb !== curTab()) { st.sel[tb] = id; setTab(tb, false); }
    var prev = st.sel[tb];
    st.sel[tb] = id;
    var changedSeen = markSeen(id);
    if (user && prev !== id) sfx('click', { volume: 0.7 });
    if (prev !== id || changedSeen) {
      var a = prev && cardEl(prev), b = cardEl(id);
      if (a) updateCard(a, getItem(prev), id);
      if (b) updateCard(b, it, id);
      if (changedSeen) { renderTabs(); hudUpdate(); }
      renderInfo(true);
      scrollSelIntoView(true);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* DOM: stage overlay + action buttons                                     */
  /* ---------------------------------------------------------------------- */
  function primaryAct(it) {
    var stt = itemState(it), pr = priceOf(it);
    if (stt === 'equipped') return null;
    if (stt === 'owned') return 'equip';
    return pr.kind === 'gems' ? 'buy' : pr.kind === 'ads' ? 'ad' : 'free';
  }

  function renderInfo(changedItem) {
    var it = selectedItem(), E = st.els;
    if (!E.stage) return;
    if (!it) {
      E.name.textContent = '';
      E.rarity.style.display = 'none';
      E.actRow.innerHTML = '';
      E.note.innerHTML = '';
      Stage.show(null);
      return;
    }
    var rc = rarityColor(it.rarity);
    E.stage.setAttribute('data-rarity', it.rarity || 'common');
    E.stage.style.setProperty('--rc', rc);
    E.stage.style.setProperty('--rc-l', shade(rc, 0.5));
    E.stage.style.setProperty('--rc-d', shade(rc, -0.5));
    E.rarity.style.display = '';
    E.rarity.textContent = it.exclusive ? t('shop.exclusive') : rarityName(it.rarity);
    E.name.textContent = itemName(it);
    if (changedItem) Stage.show(it);
    renderActions(it);
  }

  function renderActions(it) {
    var E = st.els, stt = itemState(it), pr = priceOf(it), html = '', note = '';
    var pending = st.adPending === it.id, anyPending = !!st.adPending;
    if (stt === 'equipped') {
      html = '<button type="button" class="shop-btn shop-btn--equipped" data-act="none" disabled><i class="shop-ic-check"></i><span>' + esc(t('shop.equipped')) + '</span></button>';
      if (it.tab !== 'outfit' || it.skin) html += '<button type="button" class="shop-btn shop-btn--sub" data-act="unequip"><span>' + esc(t('shop.unequip')) + '</span></button>';
    } else if (stt === 'owned') {
      html = '<button type="button" class="shop-btn shop-btn--equip" data-act="equip"><span>' + esc(t('shop.equip')) + '</span></button>';
    } else if (pr.kind === 'gems') {
      var short = gems() < pr.n;
      html = '<button type="button" class="shop-btn shop-btn--buy' + (short ? ' is-short' : '') + '" data-act="buy"' + (short || anyPending ? ' disabled aria-disabled="true"' : '') + '>' +
        '<span>' + esc(short ? t('shop.notEnough') : t('shop.buy')) + '</span>' +
        '<span class="shop-btn-price"><img src="' + esc(asset(IMG.gem)) + '" alt="" draggable="false"><b>' + fmt(pr.n) + '</b></span></button>';
      if (short) {
        note = '<span>' + esc(t('shop.needMore', fmt(pr.n - gems()))) + '</span>';
        if (SE.UI && SE.UI.panels ? SE.UI.panels.wheel : true) note += ' <button type="button" class="shop-link" data-act="wheel">' + esc(t('shop.toWheel')) + '</button>';
      }
    } else if (pr.kind === 'ads') {
      var v = Math.min(pr.n, adViews(it.id)), ready = adReady(), pips = '';
      for (var i = 0; i < pr.n; i++) pips += '<i' + (i < v ? ' class="on"' : '') + '></i>';
      if (pending) {
        html = '<button type="button" class="shop-btn shop-btn--ad is-busy" data-act="none" disabled aria-busy="true"><i class="shop-spin"></i><span>' + esc(t('shop.adPlaying')) + '</span></button>';
      } else {
        html = '<button type="button" class="shop-btn shop-btn--ad" data-act="ad"' + (!ready || anyPending ? ' disabled aria-disabled="true"' : '') + '>' +
          '<img class="shop-btn-ic" src="' + esc(asset(IMG.ad)) + '" alt="" draggable="false">' +
          '<span>' + esc(t('shop.adCta')) + '</span><span class="shop-btn-prog"><b>' + v + '/' + pr.n + '</b><span class="shop-pips">' + pips + '</span></span></button>';
      }
      var left = pr.n - v;
      note = !ready && !pending ? '<span class="is-warn">' + esc(t('shop.adUnavailable')) + '. ' + esc(t('shop.adUnavailableNote')) + '</span>'
        : '<span>' + esc(left <= 1 ? t('shop.adLeftOne') : t('shop.adLeft', left)) + '</span>';
      st.adReadyLast = ready;
    } else {
      html = '<button type="button" class="shop-btn shop-btn--buy" data-act="free"><span>' + esc(t('shop.get')) + '</span></button>';
    }
    if (it.skin && !note) {
      var ss = SE.Cosmetics && SE.Cosmetics.skinStatus ? SE.Cosmetics.skinStatus(it.id) : 'ready';
      note = '<span>' + esc(t(ss === 'missing' ? 'shop.skinSoon' : 'shop.skinNote')) + '</span>';
    }
    E.actRow.innerHTML = html;
    E.note.innerHTML = note;
    E.note.style.display = note ? '' : 'none';
  }

  function renderWallet(animate) {
    var target = gems(), from = st.walletShown === null ? target : st.walletShown;
    st.walletShown = target;
    var ws = st.els.wallets || [];
    ws.forEach(function (w) {
      if (!w) return;
      w.title = t('shop.wallet', fmt(target));
      var n = w.querySelector('.shop-wallet-n');
      if (!n) { w.innerHTML = walletHTML(); return; }
      if (!animate || from === target) { n.textContent = fmt(target); return; }
      w.classList.remove('is-down', 'is-up');
      void w.offsetWidth;
      w.classList.add(target < from ? 'is-down' : 'is-up');
      var t0 = now(), dur = 520;
      (function tick() {
        var k = Math.min(1, (now() - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        n.textContent = fmt(Math.round(from + (target - from) * e));
        if (k < 1 && w.isConnected) global.requestAnimationFrame(tick);
      })();
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */
  function runAction(act, btn) {
    var it = selectedItem();
    if (!it || !act || act === 'none') return;
    if (act === 'wheel') {
      if (locked(500)) return;
      sfx('click');
      try { if (SE.UI && typeof SE.UI.open === 'function') SE.UI.open('wheel'); } catch (e) { /* optional panel */ }
      return;
    }
    if (st.adPending) return;
    if (act === 'buy') buy(it, btn);
    else if (act === 'ad') watchAd(it);
    else if (act === 'equip') equip(it);
    else if (act === 'unequip') unequip(it);
    else if (act === 'free') claimFree(it);
  }

  function refuse(btn) {
    sfx('error');
    var b = btn || (st.els.actRow && st.els.actRow.querySelector('.shop-btn'));
    if (b) { b.classList.remove('is-shake'); void b.offsetWidth; b.classList.add('is-shake'); }
  }

  function afterChange(it, kind) {
    refreshCards();
    renderTabs();
    renderInfo(false);
    renderWallet(kind === 'buy');
    hudUpdate();
  }

  function buy(it, btn) {
    if (locked(600)) return;
    var pr = priceOf(it), s = S();
    if (!s || owns(it.id) || pr.kind !== 'gems') return;
    if (!s.canAffordGems || !s.canAffordGems(pr.n)) { refuse(btn); renderInfo(false); return; }
    if (!s.spendGems(pr.n)) { refuse(btn); return; }
    if (!s.grantItem(it.id)) {
      s.addGems(pr.n);                       // refund: the item could not be granted
      toast(t('shop.error'), 'error');
      refuse(btn);
      return;
    }
    markSeen(it.id);
    saveState();
    sfx('buy');
    afterChange(it, 'buy');
    celebrate(it, t('shop.bought'));
  }

  function claimFree(it) {
    if (locked(600)) return;
    var s = S();
    if (!s || owns(it.id) || priceOf(it).kind !== 'free') return;
    if (!s.grantItem(it.id)) { toast(t('shop.error'), 'error'); return; }
    markSeen(it.id);
    saveState();
    sfx('unlock');
    afterChange(it, 'free');
    celebrate(it, t('shop.unlocked'));
  }

  function watchAd(it) {
    if (st.adPending || locked(900)) return;
    var pr = priceOf(it), s = S();
    if (!s || owns(it.id) || pr.kind !== 'ads') return;
    if (!adReady()) { toast(t('shop.adUnavailable'), 'info'); refuse(); renderInfo(false); return; }
    var id = it.id, token = ++st.adToken, granted = false, finished = false, unlocked = false, views = 0;
    st.adPending = id;
    renderInfo(false);
    refreshCards();
    sfx('click');

    function onGranted() {
      if (granted || finished) return;           // the reward is granted once only
      granted = true;
      views = s.addAdView(id);
      if (views >= pr.n && !owns(id)) unlocked = s.grantItem(id);
      if (unlocked) markSeen(id);
      saveState();
    }
    function onDone(ok) {
      if (finished) return;
      finished = true;
      if (ok === true && !granted) onGranted();   // SDKs that only report through onDone
      if (st.adToken === token) st.adPending = null;
      if (st.watchdog) { clearTimeout(st.watchdog); st.watchdog = 0; }
      if (granted) {
        if (unlocked) { sfx('unlock'); celebrate(getItem(id), t('shop.unlocked')); }
        else { sfx('ad_reward'); toast(t('shop.adCounted', Math.min(views, pr.n), pr.n), 'good'); pipPulse(id); }
      } else {
        toast(t('shop.adNotFinished'), 'info');
      }
      if (st.root && st.root.isConnected) afterChange(getItem(id), 'ad');
      hudUpdate();
    }
    /* Safety net: an SDK that never calls back must not leave the button spinning forever. */
    st.watchdog = setTimeout(function () {
      if (!finished && st.adToken === token && !adPlatformBusy()) onDone(false);
    }, 120000);
    try {
      if (SE.Ads && typeof SE.Ads.rewarded === 'function') SE.Ads.rewarded('shop-unlock', onGranted, onDone);
      else if (SE.Platform && typeof SE.Platform.showRewarded === 'function') SE.Platform.showRewarded('shop-unlock', onGranted, onDone);
      else onDone(false);
    } catch (e) {
      console.error('[shop] rewarded failed', e);
      onDone(false);
    }
  }

  function equip(it) {
    if (locked(400)) return;
    var s = S();
    if (!s || !owns(it.id)) return;
    var before = equippedMap().outfit, d0 = sdata();
    if (it.skin && d0 && before && !(getItem(before) || {}).skin) d0.cosPrevOutfit = before;
    if (!s.equipItem(it.id)) { refuse(); return; }
    applyToPlayer();
    saveState();
    sfx('equip');
    Stage.pop = 0;
    Stage.show(it);
    afterChange(it, 'equip');
    var b = st.els.actRow && st.els.actRow.querySelector('.shop-btn--equipped');
    if (b) b.classList.add('is-fresh');
  }

  function unequip(it) {
    if (locked(400)) return;
    var s = S();
    if (!s || !isEquipped(it) || !s.unequipSlot) return;
    var d1 = sdata(), prev = d1 && d1.cosPrevOutfit;
    if (it.skin && prev && owns(prev) && !(getItem(prev) || {}).skin) s.equipItem(prev);
    else s.unequipSlot(it.tab);
    applyToPlayer();
    saveState();
    sfx('toggle');
    afterChange(it, 'unequip');
  }

  function pipPulse(id) {
    var c = cardEl(id);
    if (c) { c.classList.remove('is-pulse'); void c.offsetWidth; c.classList.add('is-pulse'); }
  }

  /* Celebration: rays + confetti + stamp in the stage, twirl in 3D, pop on the card. */
  function celebrate(it, text) {
    var E = st.els;
    if (!E.burst || !it) return;
    Stage.celebrate();
    var b = E.burst, html = '<i class="shop-burst-rays"></i><span class="shop-stamp">' + esc(text) + '</span>';
    var colors = ['#ffd84a', '#ff6b6b', '#6be3ff', '#8dff7a', '#d08bff', '#ffffff', rarityColor(it.rarity)];
    for (var i = 0; i < 26; i++) {
      var a = (i / 26) * Math.PI * 2 + Math.random() * 0.3, d = 70 + Math.random() * 90;
      html += '<b class="shop-confetti" style="--x:' + Math.round(Math.cos(a) * d) + 'px;--y:' + Math.round(Math.sin(a) * d * 0.8 - 30) +
        'px;--r:' + Math.round(Math.random() * 720 - 360) + 'deg;--c:' + colors[i % colors.length] + ';--d:' + (Math.random() * 0.12).toFixed(2) + 's"></b>';
    }
    b.innerHTML = html;
    b.classList.remove('is-on');
    void b.offsetWidth;
    b.classList.add('is-on');
    clearTimeout(st.burstTimer);
    st.burstTimer = setTimeout(function () { b.classList.remove('is-on'); b.innerHTML = ''; }, 1700);
    var c = cardEl(it.id);
    if (c) { c.classList.remove('is-won'); void c.offsetWidth; c.classList.add('is-won'); }
  }

  /* ---------------------------------------------------------------------- */
  /* Panel lifecycle                                                         */
  /* ---------------------------------------------------------------------- */
  function applyOpenData(data) {
    if (!data || typeof data !== 'object') return;
    if (data.item) {
      var it = getItem(data.item);
      if (it && visible(it)) { st.tab = stab(it); st.sel[st.tab] = it.id; st.scroll[st.tab] = 0; }
    } else if (data.tab && tabIds().indexOf(data.tab) >= 0) {
      st.tab = data.tab;
    }
  }

  function render(body, data) {
    if (!body) return;
    var reuse = st.root && st.root.parentNode === body && st.root.isConnected && !(data && (data.tab || data.item));
    applyOpenData(data);
    st.body = body;
    st.open = true;
    if (reuse) { sync(); startLive(); return; }
    if (body.classList) body.classList.add('shop-host');
    while (body.firstChild) body.removeChild(body.firstChild);
    build(body);
    Stage.yaw = (FRAMING[curTab()] || FRAMING.outfit).yaw;
    Stage.spinTo = null;
    Stage.idleAt = now() + 1200;
    startLive();
  }

  function startLive() {
    Stage.start();
    clearInterval(st.timer);
    st.timer = setInterval(function () {
      if (!st.root || !st.root.isConnected) { onClosed(); return; }
      /* ad availability can change (cooldowns, SDK); keep the button honest */
      var it = selectedItem();
      if (it && !st.adPending && itemState(it) === 'locked' && priceOf(it).kind === 'ads' && adReady() !== st.adReadyLast) renderInfo(false);
      if (gems() !== st.walletShown) { renderWallet(true); refreshCards(); renderInfo(false); }
    }, 1000);
  }

  function onClosed() {
    st.open = false;
    Stage.stop();
    clearInterval(st.timer);
    st.timer = 0;
    if (st.io) { try { st.io.disconnect(); } catch (e) { /* ignore */ } st.io = null; }
    if (st.els.gridWrap) st.scroll[curTab()] = st.els.gridWrap.scrollTop;
  }

  /* Re-sync everything from SE.State (after wheel / daily grants, language change, refresh()). */
  function sync() {
    if (!st.root || !st.root.isConnected) return;
    renderTabs();
    refreshCards();
    var it = selectedItem();
    renderInfo(!!(it && Stage.currentKey.split('|')[0] !== it.id));
    renderWallet(false);
  }

  function rebuildTexts() {
    if (!st.root || !st.root.isConnected) return;
    var hint = st.root.querySelector('.shop-drag-hint span');
    if (hint) hint.textContent = t('shop.dragHint');
    renderTabs();
    renderGrid(false);
    renderInfo(false);
    renderWallet(false);
  }

  var panelDef = {
    titleKey: 'shop.title',
    icon: 'shop',
    size: 'l',
    flush: true,
    render: function (body, data, panel) { render(body, data, panel); },
    onOpen: function (data) {
      var od = (data && typeof data === 'object' && (data.tab || data.item)) ? data : { tab: 'mythic' };   // the Mythic tab opens first
      if (st.root && st.root.isConnected) { applyOpenData(od); renderTabs(); renderGrid(true); renderInfo(true); }
      st.open = true;
      if (st.root && st.root.isConnected) startLive();
    },
    onClose: function () { onClosed(); }
  };

  function register() {
    if (st.registered) return true;
    if (!SE.UI || typeof SE.UI.registerPanel !== 'function') return false;
    try { SE.UI.registerPanel('shop', panelDef); st.registered = true; } catch (e) { console.error('[shop] registerPanel failed', e); }
    return st.registered;
  }
  if (!register()) {
    var tries = 0;
    var iv = setInterval(function () { if (register() || ++tries > 200) clearInterval(iv); }, 50);
  }
  if (SE.I18N && SE.I18N.onChange) SE.I18N.onChange(function () { rebuildTexts(); });
  /* not on Playables (pauseOnHidden false: no Page Visibility API there; the platform pause freezes the page) */
  if (doc && !(SE.Platform && SE.Platform.pauseOnHidden === false)) doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) Stage.stop(); else if (st.open && st.root && st.root.isConnected) Stage.start();
  });

  SE.ShopUI = {
    panel: panelDef,
    open: function (tab, itemId) {
      if (SE.UI && typeof SE.UI.open === 'function') SE.UI.open('shop', { tab: tab || null, item: itemId || null });
    },
    newCount: function () {
      var n = 0;
      tabIds().forEach(function (tab) { n += tabCounts(tab).fresh; });
      return n;
    },
    refresh: function () { sync(); },
    select: function (itemId) { selectId(itemId, false); },
    dispose: function () { onClosed(); Stage.dispose(); st.thumbs = {}; st.thumbFail = {}; },
    info: function () {
      var it = st.root && st.root.isConnected ? selectedItem() : null;
      return { open: !!(st.open && st.root && st.root.isConnected), tab: st.tab, selected: it ? it.id : null,
        adPending: st.adPending, webgl: !!Stage.ok && !Stage.lost, running: Stage.running };
    },
    _stage: Stage
  };
})(window);
