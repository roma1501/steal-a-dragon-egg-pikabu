/* =========================================================================
   Steal a Dragon Egg — i18n core (SE.I18N, SE.t)

   Core only: language state, dictionaries, lookup with fallback, Russian
   plurals, duration formatting and [data-i18n*] DOM application. Every feature
   module registers its own strings at load time:

     SE.I18N.add({ ru:{ 'shop.title':'Магазин' }, en:{ … }, tr:{ … } });

   API
     SE.I18N.lang                 current language ('ru' | 'en' | 'tr')
     SE.I18N.available            ['ru','en','tr']
     SE.I18N.labels               { ru:'Русский', en:'English', tr:'Türkçe' }
     SE.I18N.add(dicts)           merge per language; later adds override earlier keys
     SE.I18N.setLang(l)           accepts 'ru', 'ru-RU', 'kk', 'tr-TR' …; unknown → 'en'.
                                  Updates <html lang>, document.title, re-applies the DOM
                                  and calls onChange listeners.
     SE.I18N.normalize(l) -> 'ru'|'en'|'tr'
     SE.I18N.t(key, ...args)      '{0}', '{1}' … placeholders. Fallback: lang → en → key.
     SE.I18N.has(key[, lang])     true when the key exists (in lang, or in any language)
     SE.I18N.keys(lang)           all keys of a language (QA: key parity between languages)
     SE.I18N.plural(n, forms[, lang])
                                  forms = 'one|few|many' (ru) / 'one|other' (en, tr) or a
                                  key whose translation holds such a string. '{0}' inside
                                  the chosen form is replaced by n.
                                  ru: plural(5,'дракон|дракона|драконов') → 'драконов'
     SE.I18N.duration(sec[, opts]) '4 мин 5 с' / '4m 5s' / '4 dk 5 sn'; opts.short → largest unit only
     SE.I18N.clock(sec)           '4:05' / '1:02:03'
     SE.I18N.apply(root)          [data-i18n] → textContent, [data-i18n-title] → title,
                                  [data-i18n-aria] → aria-label, [data-i18n-placeholder]
                                  → placeholder (root itself included)
     SE.I18N.onChange(fn) / offChange(fn)
     SE.t(key, ...args)           alias of SE.I18N.t

   Missing keys: when SE.Config.DEBUG, console.warn once per key (and once per key
   that exists in en but is missing in the current language).

   Language choice is made by SE.Game (SE.Config.LANG → platform language);
   until then the initial language is SE.Config.LANG or the browser language.
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};

  var LANGS = ['ru', 'en', 'tr'];
  var DICT = { ru: {}, en: {}, tr: {} };
  var warned = {};

  /* Languages of the CIS audience read Russian best; Azerbaijani reads Turkish best. */
  var ALIAS = {
    ru: 'ru', be: 'ru', kk: 'ru', uk: 'ru', uz: 'ru', ky: 'ru', tg: 'ru', tk: 'ru', hy: 'ru', ka: 'ru', mo: 'ru',
    tr: 'tr', az: 'tr',
    en: 'en'
  };

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isDebug() { return !!(SE.Config && SE.Config.DEBUG); }

  function warnOnce(id, message) {
    if (!isDebug() || warned[id]) return;
    warned[id] = true;
    if (typeof console !== 'undefined' && console.warn) console.warn('[i18n] ' + message);
  }

  function format(str, args, offset) {
    if (args.length <= offset || str.indexOf('{') < 0) return str;
    return str.replace(/\{(\d+)\}/g, function (whole, num) {
      var i = offset + Number(num);
      return i < args.length && args[i] !== undefined && args[i] !== null ? String(args[i]) : whole;
    });
  }

  function lookup(key, lang) {
    var d = DICT[lang];
    return d && hasOwn(d, key) ? d[key] : undefined;
  }

  function ruIndex(n) {
    n = Math.abs(Math.floor(Number(n) || 0));
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 0;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 1;
    return 2;
  }

  var I18N = {
    lang: 'en',
    available: LANGS.slice(),
    labels: { ru: 'Русский', en: 'English', tr: 'Türkçe' },
    listeners: [],

    normalize: function (l) {
      if (typeof l !== 'string' || !l) return 'en';
      var code = l.toLowerCase().replace('_', '-').split('-')[0];
      return ALIAS[code] || 'en';
    },

    add: function (dicts) {
      if (!dicts || typeof dicts !== 'object') return this;
      for (var lang in dicts) {
        if (!hasOwn(dicts, lang) || !DICT[lang]) continue;
        var src = dicts[lang];
        if (!src || typeof src !== 'object') continue;
        for (var key in src) {
          if (hasOwn(src, key) && typeof src[key] === 'string') DICT[lang][key] = src[key];
        }
      }
      return this;
    },

    keys: function (lang) { return DICT[lang] ? Object.keys(DICT[lang]) : []; },

    has: function (key, lang) {
      if (lang) return lookup(key, lang) !== undefined;
      for (var i = 0; i < LANGS.length; i++) if (lookup(key, LANGS[i]) !== undefined) return true;
      return false;
    },

    setLang: function (l) {
      var lang = this.normalize(l);
      this.lang = lang;
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.setAttribute('lang', lang);
        var title = lookup('game.title', lang);
        if (title) document.title = title;
        this.apply(document);
      }
      var list = this.listeners.slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](lang); } catch (e) {
          if (typeof console !== 'undefined' && console.error) console.error(e);
        }
      }
      return lang;
    },

    onChange: function (fn) { if (typeof fn === 'function') this.listeners.push(fn); },
    offChange: function (fn) {
      var i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    },

    t: function (key) {
      if (typeof key !== 'string') return '';
      var s = lookup(key, this.lang);
      if (s === undefined) {
        s = lookup(key, 'en');
        if (s === undefined) {
          warnOnce('key:' + key, 'missing key "' + key + '"');
          return key;
        }
        warnOnce(this.lang + ':' + key, 'key "' + key + '" missing in "' + this.lang + '"');
      }
      return format(s, arguments, 1);
    },

    plural: function (n, forms, lang) {
      lang = lang && DICT[lang] ? lang : this.lang;
      if (typeof forms !== 'string') return '';
      if (forms.indexOf('|') < 0) {
        var tr = lookup(forms, lang);
        if (tr === undefined) tr = lookup(forms, 'en');
        if (tr !== undefined) forms = tr;
      }
      var parts = forms.split('|');
      var form;
      if (lang === 'ru') {
        form = parts[Math.min(ruIndex(n), parts.length - 1)];
      } else {
        form = Math.abs(Number(n)) === 1 ? parts[0] : parts[parts.length - 1];
      }
      return form.replace(/\{0\}/g, String(n));
    },

    duration: function (sec, opts) {
      sec = Math.max(0, Math.ceil(Number(sec) || 0));
      var short = !!(opts && opts.short);
      var d = Math.floor(sec / 86400);
      var h = Math.floor((sec % 86400) / 3600);
      var m = Math.floor((sec % 3600) / 60);
      var s = sec % 60;
      if (d > 0) return short || h === 0 ? this.t('time.d', d) : this.t('time.dh', d, h);
      if (h > 0) return short || m === 0 ? this.t('time.h', h) : this.t('time.hm', h, m);
      if (m > 0) return short || s === 0 ? this.t('time.m', m) : this.t('time.ms', m, s);
      return this.t('time.s', s);
    },

    clock: function (sec) {
      sec = Math.max(0, Math.ceil(Number(sec) || 0));
      var h = Math.floor(sec / 3600);
      var m = Math.floor((sec % 3600) / 60);
      var s = sec % 60;
      var ss = (s < 10 ? '0' : '') + s;
      if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss;
      return m + ':' + ss;
    },

    apply: function (root) {
      if (typeof document === 'undefined') return;
      root = root || document;
      if (!root.querySelectorAll) return;
      var self = this;
      function each(attr, fn) {
        var nodes = Array.prototype.slice.call(root.querySelectorAll('[' + attr + ']'));
        if (root.hasAttribute && root.hasAttribute(attr)) nodes.unshift(root);
        for (var i = 0; i < nodes.length; i++) {
          var key = nodes[i].getAttribute(attr);
          if (key) fn(nodes[i], self.t(key));
        }
      }
      each('data-i18n', function (el, text) { el.textContent = text; });
      each('data-i18n-title', function (el, text) { el.setAttribute('title', text); });
      each('data-i18n-aria', function (el, text) { el.setAttribute('aria-label', text); });
      each('data-i18n-placeholder', function (el, text) { el.setAttribute('placeholder', text); });
    }
  };

  /* ------------------------------------------------------------------ */
  /* COMMON strings (features register their own).                       */
  /* ------------------------------------------------------------------ */
  I18N.add({
    ru: {
      'game.title': 'Укради Яйцо Дракона',
      'game.subtitle': 'Кради яйца, выращивай драконов, стань самым быстрым!',

      'loading.title': 'Загрузка…',
      'loading.percent': '{0}%',
      'loading.stage.platform': 'Подключаемся к платформе…',
      'loading.stage.save': 'Загружаем прогресс…',
      'loading.stage.assets': 'Будим драконов…',
      'loading.stage.audio': 'Настраиваем звук…',
      'loading.stage.world': 'Строим долину логов…',
      'loading.stage.ready': 'Готово!',
      'loading.play': 'Играть',
      'loading.tap': 'Нажми, чтобы начать',
      'loading.retrying': 'Пробуем ещё раз…',
      'loading.error.webgl': 'Не удалось запустить 3D-графику. Включи аппаратное ускорение в браузере и попробуй снова.',
      'loading.error.save': 'Не удалось загрузить сохранение. Проверь подключение к интернету и попробуй снова.',
      'loading.error.assets': 'Не удалось загрузить файлы игры. Проверь подключение к интернету и попробуй снова.',
      'loading.error.generic': 'Что-то пошло не так. Попробуй ещё раз.',
      'loading.tip1': 'Совет: чем дальше логово, тем ценнее яйца — и тем быстрее драконы.',
      'loading.tip2': 'Совет: тренируйся на беговой дорожке, чтобы убегать от драконов.',
      'loading.tip3': 'Совет: за белой линией базы драконы тебя не тронут.',
      'loading.tip4': 'Совет: дракончики в команде приносят полный доход, остальные — 10 %.',
      'loading.tip5': 'Совет: золотые, кристальные и радужные дракончики приносят гораздо больше монет.',
      'loading.tip6': 'Совет: спящий дракон просыпается не сразу — хватай яйцо и беги!',
      'loading.tip7': 'Совет: чем больше инкубаторов, тем больше яиц вылупляется одновременно.',
      'loading.tip8': 'Совет: галактический дракончик — большая редкость, примерно один из 250!',
      'loading.tip9': 'Совет: огненные драконы мечут огненные шары — уходи из красного круга!',
      'loading.tip10': 'Совет: у входа в каждое логово стоит табличка с рекомендуемой скоростью.',

      'btn.ok': 'ОК',
      'btn.close': 'Закрыть',
      'btn.next': 'Далее',
      'btn.retry': 'Повторить',
      'btn.buy': 'Купить',
      'btn.equip': 'Надеть',
      'btn.equipped': 'Надето',
      'btn.owned': 'Получено',
      'btn.claim': 'Забрать',
      'btn.skip': 'Пропустить',
      'btn.back': 'Назад',
      'btn.yes': 'Да',
      'btn.no': 'Нет',
      'btn.continue': 'Продолжить',
      'btn.cancel': 'Отмена',
      'btn.watchAd': 'За рекламу',
      'btn.watchAdLong': 'Посмотреть рекламу',

      'cur.cash': 'Деньги',
      'cur.gems': 'Самоцветы',
      'cur.gemsUnit': '{0} самоцвет|{0} самоцвета|{0} самоцветов',

      'time.s': '{0} с',
      'time.m': '{0} мин',
      'time.h': '{0} ч',
      'time.d': '{0} д',
      'time.ms': '{0} мин {1} с',
      'time.hm': '{0} ч {1} мин',
      'time.dh': '{0} д {1} ч',
      'time.perSec': '/с',
      'time.in': 'через {0}',
      'time.ready': 'Готово!'
    },
    en: {
      'game.title': 'Steal a Dragon Egg',
      'game.subtitle': 'Steal eggs, raise dragons, become the fastest!',

      'loading.title': 'Loading…',
      'loading.percent': '{0}%',
      'loading.stage.platform': 'Connecting to the platform…',
      'loading.stage.save': 'Loading your progress…',
      'loading.stage.assets': 'Waking up the dragons…',
      'loading.stage.audio': 'Tuning the sound…',
      'loading.stage.world': 'Building the valley of lairs…',
      'loading.stage.ready': 'Ready!',
      'loading.play': 'Play',
      'loading.tap': 'Tap to start',
      'loading.retrying': 'Trying again…',
      'loading.error.webgl': 'Could not start 3D graphics. Turn on hardware acceleration in your browser and try again.',
      'loading.error.save': 'Could not load your save. Check your internet connection and try again.',
      'loading.error.assets': 'Could not load the game files. Check your internet connection and try again.',
      'loading.error.generic': 'Something went wrong. Please try again.',
      'loading.tip1': 'Tip: the farther the lair, the more valuable the eggs — and the faster the dragons.',
      'loading.tip2': 'Tip: train on the treadmill to outrun the dragons.',
      'loading.tip3': 'Tip: dragons can\'t touch you behind the white line of your base.',
      'loading.tip4': 'Tip: baby dragons in your team earn full income, the rest earn 10%.',
      'loading.tip5': 'Tip: Golden, Crystal and Rainbow babies earn far more coins.',
      'loading.tip6': 'Tip: a sleeping dragon needs a moment to wake up — grab the egg and run!',
      'loading.tip7': 'Tip: more hatcheries means more eggs hatching at once.',
      'loading.tip8': 'Tip: Galaxy babies are super rare — about 1 in 250!',
      'loading.tip9': 'Tip: Ember dragons hurl fireballs — get out of the red circle!',
      'loading.tip10': 'Tip: every lair entrance has a sign with the recommended speed.',

      'btn.ok': 'OK',
      'btn.close': 'Close',
      'btn.next': 'Next',
      'btn.retry': 'Retry',
      'btn.buy': 'Buy',
      'btn.equip': 'Equip',
      'btn.equipped': 'Equipped',
      'btn.owned': 'Owned',
      'btn.claim': 'Claim',
      'btn.skip': 'Skip',
      'btn.back': 'Back',
      'btn.yes': 'Yes',
      'btn.no': 'No',
      'btn.continue': 'Continue',
      'btn.cancel': 'Cancel',
      'btn.watchAd': 'Watch ad',
      'btn.watchAdLong': 'Watch ad',

      'cur.cash': 'Cash',
      'cur.gems': 'Gems',
      'cur.gemsUnit': '{0} gem|{0} gems',

      'time.s': '{0}s',
      'time.m': '{0}m',
      'time.h': '{0}h',
      'time.d': '{0}d',
      'time.ms': '{0}m {1}s',
      'time.hm': '{0}h {1}m',
      'time.dh': '{0}d {1}h',
      'time.perSec': '/s',
      'time.in': 'in {0}',
      'time.ready': 'Ready!'
    },
    tr: {
      'game.title': 'Ejderha Yumurtası Çal',
      'game.subtitle': 'Yumurtaları çal, ejderhaları büyüt, en hızlısı ol!',

      'loading.title': 'Yükleniyor…',
      'loading.percent': '%{0}',
      'loading.stage.platform': 'Platforma bağlanılıyor…',
      'loading.stage.save': 'İlerlemen yükleniyor…',
      'loading.stage.assets': 'Ejderhalar uyandırılıyor…',
      'loading.stage.audio': 'Sesler ayarlanıyor…',
      'loading.stage.world': 'İnler vadisi kuruluyor…',
      'loading.stage.ready': 'Hazır!',
      'loading.play': 'Oyna',
      'loading.tap': 'Başlamak için dokun',
      'loading.retrying': 'Tekrar deneniyor…',
      'loading.error.webgl': '3D grafikler başlatılamadı. Tarayıcında donanım hızlandırmayı aç ve tekrar dene.',
      'loading.error.save': 'Kayıt yüklenemedi. İnternet bağlantını kontrol et ve tekrar dene.',
      'loading.error.assets': 'Oyun dosyaları yüklenemedi. İnternet bağlantını kontrol et ve tekrar dene.',
      'loading.error.generic': 'Bir şeyler ters gitti. Lütfen tekrar dene.',
      'loading.tip1': 'İpucu: in ne kadar uzaksa yumurtalar o kadar değerli — ejderhalar da o kadar hızlı.',
      'loading.tip2': 'İpucu: ejderhalardan kaçmak için koşu bandında antrenman yap.',
      'loading.tip3': 'İpucu: üssünün beyaz çizgisinin ardında ejderhalar sana dokunamaz.',
      'loading.tip4': 'İpucu: takımındaki yavru ejderhalar tam gelir, diğerleri %10 kazandırır.',
      'loading.tip5': 'İpucu: Altın, Kristal ve Gökkuşağı yavrular çok daha fazla para kazandırır.',
      'loading.tip6': 'İpucu: uyuyan ejderhanın uyanması biraz sürer — yumurtayı kap ve koş!',
      'loading.tip7': 'İpucu: ne kadar çok kuluçkalık, aynı anda o kadar çok yumurta çatlar.',
      'loading.tip8': 'İpucu: Galaksi yavrular çok nadirdir — yaklaşık 250\'de 1!',
      'loading.tip9': 'İpucu: Kor ejderhaları ateş topu fırlatır — kırmızı daireden çık!',
      'loading.tip10': 'İpucu: her inin girişinde önerilen hızı gösteren bir tabela var.',

      'btn.ok': 'Tamam',
      'btn.close': 'Kapat',
      'btn.next': 'İleri',
      'btn.retry': 'Tekrar dene',
      'btn.buy': 'Satın al',
      'btn.equip': 'Kuşan',
      'btn.equipped': 'Kuşanıldı',
      'btn.owned': 'Sende var',
      'btn.claim': 'Al',
      'btn.skip': 'Geç',
      'btn.back': 'Geri',
      'btn.yes': 'Evet',
      'btn.no': 'Hayır',
      'btn.continue': 'Devam',
      'btn.cancel': 'İptal',
      'btn.watchAd': 'Reklam izle',
      'btn.watchAdLong': 'Reklam izle',

      'cur.cash': 'Para',
      'cur.gems': 'Mücevher',
      'cur.gemsUnit': '{0} mücevher|{0} mücevher',

      'time.s': '{0} sn',
      'time.m': '{0} dk',
      'time.h': '{0} sa',
      'time.d': '{0} g',
      'time.ms': '{0} dk {1} sn',
      'time.hm': '{0} sa {1} dk',
      'time.dh': '{0} g {1} sa',
      'time.perSec': '/sn',
      'time.in': '{0} sonra',
      'time.ready': 'Hazır!'
    }
  });

  /* Initial language until SE.Game decides (Config.LANG → browser language). */
  (function initialLang() {
    var l = SE.Config && SE.Config.LANG;
    if (!l && typeof navigator !== 'undefined') l = navigator.language || (navigator.languages && navigator.languages[0]);
    I18N.lang = I18N.normalize(l);
  })();

  SE.I18N = I18N;
  SE.t = function () { return I18N.t.apply(I18N, arguments); };
})(typeof window !== 'undefined' ? window : globalThis);
