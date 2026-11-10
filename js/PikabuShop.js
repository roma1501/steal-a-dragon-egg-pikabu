// @ts-nocheck
// PikabuShop.js — магазин наборов за рубли (внутриигровые покупки Пикабу Игр, sdk.store).
// Работает только в сборке pikabu: ждёт Platform.sdk со store (его ставит адаптер PlatformPikabu) и список
// товаров из Студии (sdk.store.getProducts). Нет SDK (блокировщик, другая площадка) или товаров — кнопки нет.
// Игра описывает наборы в js/PikabuPacks.js: PikabuShop.setup({ packs, ready, visible, persist, button }).
//   pack: { id, type: 'consumable' | 'non_consumable', icon, name, desc, best?, noAds?, grant(), apply?() }
//   grant()  — начислить содержимое; один раз на покупку (purchaseId помнится в localStorage)
//   apply()  — для постоянных наборов: применить владение при каждом запуске (например, предметы)
//   noAds    — постоянный набор «Без рекламы»: межстраничная реклама не показывается (награды за рекламу остаются)
// Расходуемые: начисление -> сохранение игры -> sdk.store.consumePurchase. Неначисленные покупки (сеть оборвалась)
// подхватываются при следующем запуске через sdk.store.getPurchases. Пока окно открыто — Pause 'shop'.
const PikabuShop = {
    cfg: null,
    products: new Map(),
    owned: new Set(),
    ready: false,
    isOpen: false,
    busy: false,
    _el: null,
    _btn: null,
    _toastT: 0,

    setup(cfg) {
        if (this.cfg) return;
        this.cfg = cfg || { packs: [] };
        this._wrapAds();
        this._wait();
    },

    // cfg.sdk / cfg.pause / cfg.wrapAds / cfg.gameId — для игр не на Lory (свой адаптер платформы)
    sdk() {
        if (this.cfg && this.cfg.sdk) return this._safe(() => this.cfg.sdk(), null) || null;
        return (typeof Platform !== 'undefined' && Platform && Platform.sdk) || null;
    },
    store() { const s = this.sdk(); return s && s.store ? s.store : null; },
    noAds() { return (this.cfg && this.cfg.packs || []).some((p) => p.noAds && this.owned.has(p.id)); },
    packs() { return (this.cfg.packs || []).filter((p) => this.products.has(p.id)); },

    async _wait() {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 1200; i++) {             // до 10 минут: SDK и сохранение игры
            const gameReady = !this.cfg.ready || this._safe(() => this.cfg.ready(), false);
            if (this.store() && gameReady) break;
            if (i > 60 && !this.sdk()) return;         // 30 с без SDK — не Пикабу или SDK заблокирован
            await sleep(500);
        }
        const st = this.store();
        if (!st) return;
        try {
            const list = await st.getProducts();
            for (const p of list || []) this.products.set(String(p.id), p);
        } catch (e) { console.warn('PikabuShop: товары не загрузились', e); }
        if (!this.packs().length) return;            // товаров в Студии ещё нет — магазин не показываем
        await this._restore();
        this.ready = true;
        this._css();
        this._button();
        setInterval(() => this._sync(), 300);
        this._sync();
    },

    _safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } },

    /** Лучшие предметы движкового Shop, которые иначе открываются только рекламой: по редкости, по одному из разных
     *  вкладок (потом — остальные). Порядок стабилен (каталог игры), поэтому набор всегда выдаёт одно и то же. */
    shopTop(n) {
        if (typeof Shop === 'undefined' || !Shop.items) return [];
        const rank = { mythic: 6, legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };
        const list = Shop.items().filter((it) => it.price && it.price.ads && !it.exclusive && !it.default)
            .map((it, i) => ({ it, i }))
            .sort((a, b) => (rank[b.it.rarity] || 0) - (rank[a.it.rarity] || 0) || (b.it.price.ads - a.it.price.ads) || a.i - b.i)
            .map((x) => x.it);
        const out = [], tabs = new Set();
        for (const it of list) if (out.length < n && !tabs.has(it.tab)) { out.push(it.id); tabs.add(it.tab); }
        for (const it of list) if (out.length < n && out.indexOf(it.id) < 0) out.push(it.id);
        return out;
    },
    /** Выдать предметы движкового Shop, которых ещё нет (без надевания поверх выбранного игроком). */
    shopGrant(ids) { if (typeof Shop !== 'undefined') for (const id of ids) if (!Shop.owns(id)) Shop.grant(id, { reason: 'pikabu' }); },

    // --- Покупки ---------------------------------------------------------------------------
    _key() { return 'pkbshop:' + ((this.cfg && this.cfg.gameId) || (typeof GAME_ID !== 'undefined' ? GAME_ID : 'game')) + ':granted'; },
    _grantedList() { try { return JSON.parse(localStorage.getItem(this._key()) || '[]') || []; } catch (e) { return []; } },
    _isGranted(id) { return this._grantedList().indexOf(id) >= 0; },
    _markGranted(id) {
        const list = this._grantedList();
        list.push(id);
        try { localStorage.setItem(this._key(), JSON.stringify(list.slice(-300))); } catch (e) { /* без localStorage — только сохранение игры */ }
    },
    _persist() { if (this.cfg.persist) this._safe(() => this.cfg.persist(), null); },

    async _restore() {
        const st = this.store();
        if (!st) return;
        let list = [];
        try { list = (await st.getPurchases()) || []; } catch (e) { console.warn('PikabuShop: список покупок не получен', e); return; }
        for (const p of list) await this._handle(p, false);
    },

    async _handle(purchase, fresh) {
        const pack = (this.cfg.packs || []).find((p) => p.id === purchase.productId);
        if (!pack) return;
        const key = String(purchase.purchaseId || purchase.productId);
        if (!this._isGranted(key)) {
            this._safe(() => pack.grant && pack.grant(), null);
            this._markGranted(key);
            this._persist();
            if (fresh) this._toast('Получено: ' + pack.name);
        }
        if (purchase.isConsumable) {
            try { await this.store().consumePurchase(purchase.purchaseId); } catch (e) { console.warn('PikabuShop: consumePurchase', e); }
        } else {
            this.owned.add(pack.id);
            this._safe(() => pack.apply && pack.apply(), null);
        }
    },

    async buy(pack) {
        const st = this.store();
        if (!st || this.busy) return;
        if (pack.type === 'non_consumable' && this.owned.has(pack.id)) return;
        this.busy = true;
        this._render();
        try {
            const r = await st.purchase({ productId: pack.id, developerPayload: JSON.stringify({ pack: pack.id }) });
            if (r && r.success) await this._handle(r.purchase, true);
            else if (r && r.reason === 'NON_CONSUMABLE_ALREADY_OWNED') { await this._restore(); this._toast('Этот набор уже ваш'); }
            else if (r && r.reason && r.reason !== 'USER_CANCELLED') this._toast(r.reason === 'USER_UNAUTHORIZED' ? 'Для покупки войдите в аккаунт Пикабу' : 'Покупка не завершена');
        } catch (e) {
            console.warn('PikabuShop: покупка', e);
            this._toast('Покупка не завершена');
        } finally {
            this.busy = false;
            this._render();
        }
    },

    // --- «Без рекламы» ----------------------------------------------------------------------
    _wrapAds() {
        if (this.cfg.wrapAds) { this._safe(() => this.cfg.wrapAds(() => this.noAds()), null); return; }
        if (typeof Platform === 'undefined' || !Platform) return;
        const self = this;
        const wrap = (name, test) => {
            const orig = Platform[name];
            if (typeof orig !== 'function' || orig.__pkbShop) return;
            const f = function (...args) {
                if (self.noAds() && test(args)) return Promise.resolve(false);
                return orig.apply(this, args);
            };
            f.__pkbShop = true;
            Platform[name] = f;
        };
        wrap('interstitial', () => true);
        wrap('_showAd', (a) => a[0] === 'interstitial' || a[0] === 'fullscreen');
        // адаптер 1.20 подменяет interstitial при init — обернуть ещё раз, когда SDK появится
        const again = setInterval(() => { if (self.sdk()) { wrap('interstitial', () => true); clearInterval(again); } }, 500);
    },

    // --- Интерфейс --------------------------------------------------------------------------
    open() {
        if (!this.ready || this.isOpen) return;
        this.isOpen = true;
        this._pause(true);
        this._render();
        this._el.classList.add('pk-show');
        this._sync();
    },
    _pause(on) {
        if (this.cfg.pause) this._safe(() => this.cfg.pause(on), null);
        else if (typeof Pause !== 'undefined') this._safe(() => Pause.set('shop', on), null);
    },
    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this._el.classList.remove('pk-show');
        this._pause(false);
        this._sync();
    },

    _sync() {
        if (!this._btn) return;
        const vis = !this.isOpen && (!this.cfg.visible || this._safe(() => this.cfg.visible(), true));
        this._btn.style.display = vis ? '' : 'none';
    },

    _button() {
        const b = document.createElement('button');
        b.id = 'pkbshop-btn';
        b.type = 'button';
        b.innerHTML = '<span class="pk-gift">🎁</span><span>Наборы</span>';
        const pos = Object.assign({ corner: 'tr', x: 12, y: 70 }, this.cfg.button || {});
        b.style[pos.corner[0] === 't' ? 'top' : 'bottom'] = 'calc(' + pos.y + 'px + env(safe-area-inset-' + (pos.corner[0] === 't' ? 'top' : 'bottom') + ', 0px))';
        b.style[pos.corner[1] === 'l' ? 'left' : 'right'] = pos.x + 'px';
        const stop = (e) => e.stopPropagation();
        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach((t) => b.addEventListener(t, stop));
        b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); this.open(); });
        document.body.appendChild(b);
        this._btn = b;

        const el = document.createElement('div');
        el.id = 'pkbshop';
        el.innerHTML = '<div class="pk-back"></div><div class="pk-panel" role="dialog" aria-label="Магазин наборов">' +
            '<div class="pk-head"><b>Магазин наборов</b><button type="button" class="pk-x" aria-label="Закрыть">✕</button></div>' +
            '<div class="pk-list"></div>' +
            '<div class="pk-foot">Оплата через Пикабу. Покупки привязаны к аккаунту и сохраняются.</div></div>';
        ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove', 'touchend', 'wheel', 'click', 'contextmenu']
            .forEach((t) => el.addEventListener(t, stop));
        el.querySelector('.pk-back').addEventListener('click', () => this.close());
        el.querySelector('.pk-x').addEventListener('click', () => this.close());
        window.addEventListener('keydown', (e) => { if (this.isOpen && e.key === 'Escape') { e.stopPropagation(); this.close(); } }, true);
        document.body.appendChild(el);
        this._el = el;
    },

    _render() {
        if (!this._el) return;
        const list = this._el.querySelector('.pk-list');
        list.innerHTML = '';
        for (const pack of this.packs()) {
            const prod = this.products.get(pack.id);
            const owned = pack.type === 'non_consumable' && this.owned.has(pack.id);
            const card = document.createElement('div');
            card.className = 'pk-card' + (pack.best ? ' pk-best' : '') + (owned ? ' pk-owned' : '');
            card.innerHTML = (pack.best ? '<span class="pk-tag">' + (pack.best === true ? 'Выгодно' : pack.best) + '</span>' : '') +
                '<div class="pk-ico">' + (pack.icon || '🎁') + '</div>' +
                '<div class="pk-name"></div><div class="pk-desc"></div>' +
                '<button type="button" class="pk-buy"></button>';
            card.querySelector('.pk-name').textContent = pack.name;
            card.querySelector('.pk-desc').textContent = pack.desc || '';
            const btn = card.querySelector('.pk-buy');
            btn.textContent = owned ? 'Куплено' : (prod && prod.formattedPrice) || ((prod ? Math.round(prod.price / 100) : '') + ' ₽');
            btn.disabled = owned || this.busy;
            btn.addEventListener('click', () => this.buy(pack));
            list.appendChild(card);
        }
    },

    _toast(text) {
        let t = document.getElementById('pkbshop-toast');
        if (!t) { t = document.createElement('div'); t.id = 'pkbshop-toast'; document.body.appendChild(t); }
        t.textContent = text;
        t.classList.add('pk-show');
        clearTimeout(this._toastT);
        this._toastT = setTimeout(() => t.classList.remove('pk-show'), 2600);
    },

    _css() {
        if (document.getElementById('pkbshop-css')) return;
        const a = (this.cfg.colors && this.cfg.colors[0]) || '#ffb020';
        const b = (this.cfg.colors && this.cfg.colors[1]) || '#ff4f8b';
        const s = document.createElement('style');
        s.id = 'pkbshop-css';
        s.textContent = `
#pkbshop-btn{position:fixed;z-index:2147482000;display:flex;align-items:center;gap:6px;padding:8px 14px 8px 10px;border:0;border-radius:999px;
 background:linear-gradient(135deg,${a},${b});color:#fff;font:800 15px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;letter-spacing:.2px;
 text-shadow:0 1px 2px rgba(0,0,0,.35);box-shadow:0 4px 0 rgba(0,0,0,.22),0 6px 18px rgba(0,0,0,.28);cursor:pointer;animation:pkPulse 2.4s ease-in-out infinite;
 -webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none}
#pkbshop-btn:active{transform:translateY(2px) scale(.97);box-shadow:0 2px 0 rgba(0,0,0,.22),0 4px 12px rgba(0,0,0,.28)}
#pkbshop-btn .pk-gift{font-size:19px;line-height:1;filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
@keyframes pkPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
#pkbshop{position:fixed;inset:0;z-index:2147482500;display:none;align-items:center;justify-content:center;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
#pkbshop.pk-show{display:flex}
#pkbshop .pk-back{position:absolute;inset:0;background:rgba(10,12,24,.66);backdrop-filter:blur(3px)}
#pkbshop .pk-panel{position:relative;width:min(760px,calc(100vw - 20px));max-height:calc(100vh - 20px);display:flex;flex-direction:column;
 background:linear-gradient(180deg,#2b2350,#1b1733);border:3px solid rgba(255,255,255,.14);border-radius:22px;box-shadow:0 18px 60px rgba(0,0,0,.55);color:#fff;overflow:hidden}
#pkbshop .pk-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px 20px;background:linear-gradient(135deg,${a},${b})}
#pkbshop .pk-head b{font-size:clamp(18px,3.4vw,24px);font-weight:900;text-shadow:0 2px 3px rgba(0,0,0,.35)}
#pkbshop .pk-x{width:38px;height:38px;border:0;border-radius:12px;background:rgba(0,0,0,.22);color:#fff;font-size:20px;font-weight:900;cursor:pointer}
#pkbshop .pk-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;padding:16px;overflow:auto;-webkit-overflow-scrolling:touch}
#pkbshop .pk-card{position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:14px 12px 12px;border-radius:18px;
 background:rgba(255,255,255,.07);border:2px solid rgba(255,255,255,.1)}
#pkbshop .pk-best{border-color:${a};background:rgba(255,190,60,.12)}
#pkbshop .pk-tag{position:absolute;top:-1px;right:10px;padding:3px 8px;border-radius:0 0 10px 10px;background:linear-gradient(135deg,${a},${b});font-size:12px;font-weight:900}
#pkbshop .pk-ico{font-size:44px;line-height:1.1;filter:drop-shadow(0 3px 4px rgba(0,0,0,.35))}
#pkbshop .pk-name{font-size:17px;font-weight:900}
#pkbshop .pk-desc{flex:1;font-size:13px;line-height:1.3;opacity:.85}
#pkbshop .pk-buy{min-width:120px;min-height:42px;margin-top:4px;padding:8px 16px;border:0;border-radius:14px;background:linear-gradient(180deg,#5fe06a,#2fae3f);
 color:#fff;font-size:17px;font-weight:900;text-shadow:0 1px 2px rgba(0,0,0,.3);box-shadow:0 4px 0 #1e7a2b;cursor:pointer}
#pkbshop .pk-buy:disabled{filter:grayscale(.6);opacity:.7;cursor:default}
#pkbshop .pk-owned .pk-buy{background:#5a5675;box-shadow:0 4px 0 #3b3852}
#pkbshop .pk-foot{padding:8px 16px 14px;font-size:12px;opacity:.65;text-align:center}
#pkbshop-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:2147483000;transform:translate(-50%,30px);opacity:0;pointer-events:none;
 padding:12px 20px;border-radius:14px;background:rgba(20,18,40,.92);color:#fff;font:800 16px system-ui,sans-serif;transition:all .25s;box-shadow:0 8px 24px rgba(0,0,0,.4)}
#pkbshop-toast.pk-show{opacity:1;transform:translate(-50%,0)}
@media (max-width:520px){#pkbshop .pk-list{grid-template-columns:1fr 1fr;gap:8px;padding:10px}#pkbshop .pk-ico{font-size:34px}#pkbshop .pk-name{font-size:15px}
 #pkbshop .pk-desc{font-size:12px}#pkbshop .pk-buy{min-width:0;width:100%;font-size:15px}#pkbshop-btn{font-size:13px;padding:7px 11px 7px 8px}}
`;
        document.head.appendChild(s);
    },
};
