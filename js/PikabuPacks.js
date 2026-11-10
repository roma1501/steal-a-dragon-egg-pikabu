// @ts-nocheck
// PikabuPacks.js — наборы за рубли в сборке Пикабу Игр (js/PikabuShop.js). Цены и названия товаров — в Студии
// (каталог CSV: coins_s 19 ₽, coins_m 49 ₽, coins_l 99 ₽, starter 29 ₽, no_ads 59 ₽), здесь — что игрок получает.
// Игра не на Lory: SDK, пауза и межстраничная реклама — через SE.Platform / SE.Game (хуки PikabuShop).
// Самоцветы — SE.State.addGems; доход ×2 — SE.Boosts (живёт в памяти, поэтому срок купленного буста хранится
// здесь и восстанавливается после перезапуска).
const PIKABU_X2 = 'pkbshop:steal-a-dragon-egg:x2until';
const PIKABU_HUD = () => {
    try { SE.UI.updateHUD(); SE.UI.updateBoosts(); } catch (e) { /* интерфейс ещё не готов */ }
};
const PIKABU_GIVE = (gems, boostMin) => {
    if (gems) SE.State.addGems(gems);
    if (boostMin) {
        SE.Boosts.activate('x2income', boostMin * 60);
        try { localStorage.setItem(PIKABU_X2, String(SE.Boosts.active.x2income || 0)); } catch (e) { /* без хранилища */ }
    }
    SE.State.save();
    PIKABU_HUD();
};
(function pikabuX2Restore() {
    const t = setInterval(() => {
        if (!(window.SE && SE.Game && SE.Game.booted && SE.Boosts)) return;
        clearInterval(t);
        let until = 0;
        try { until = Number(localStorage.getItem(PIKABU_X2)) || 0; } catch (e) { /* без хранилища */ }
        const left = (until - Date.now()) / 1000;
        if (left > 1 && !SE.Boosts.isActive('x2income')) { SE.Boosts.activate('x2income', left); PIKABU_HUD(); }
    }, 1000);
})();
PikabuShop.setup({
    gameId: 'steal-a-dragon-egg',
    colors: ['#ff7a1a', '#c2185b'],
    sdk: () => (window.SE && SE.Platform && SE.Platform.sdk) || null,
    pause: (on) => SE.Game.setPaused(on, 'shop'),
    wrapAds: (blocked) => {
        const P = SE.Platform;
        const orig = P.showInterstitial, can = P.canInterstitial;
        if (typeof orig !== 'function' || orig.__pkbShop) return;
        const f = function (a, b) {
            if (blocked()) { const cb = typeof a === 'function' ? a : b; if (typeof cb === 'function') setTimeout(() => cb(false), 0); return; }
            return orig.apply(this, arguments);
        };
        f.__pkbShop = true;
        P.showInterstitial = f;
        if (typeof can === 'function') P.canInterstitial = function () { return !blocked() && can.apply(this, arguments); };
    },
    ready: () => !!(window.SE && SE.Game && SE.Game.booted && SE.State && SE.State.data && SE.UI),
    visible: () => !SE.UI.isOpen() && !(SE.Tutorial && SE.Tutorial.isActive && SE.Tutorial.isActive()),
    persist: () => SE.State.save(),
    button: { corner: 'tr', x: 12, y: 12 },
    packs: [
        { id: 'coins_s', type: 'consumable', icon: '💎', name: 'Горсть самоцветов', desc: '300 самоцветов на облики, шапки, крылья и следы', grant: () => PIKABU_GIVE(300, 0) },
        { id: 'coins_m', type: 'consumable', icon: '💰', name: 'Мешок самоцветов', desc: '1 000 самоцветов и доход ×2 на 30 минут', grant: () => PIKABU_GIVE(1000, 30) },
        { id: 'coins_l', type: 'consumable', icon: '👑', name: 'Сундук самоцветов', desc: '3 000 самоцветов и доход ×2 на 2 часа', best: true, grant: () => PIKABU_GIVE(3000, 120) },
        {
            id: 'starter', type: 'non_consumable', icon: '🔥', name: 'Огненный набор', best: 'Один раз',
            desc: '500 самоцветов, облик «Капучино Драгонино», пламенная корона и огненные крылья',
            grant: () => PIKABU_GIVE(500, 0),
            apply: () => {
                let n = 0;
                for (const id of ['skin_cappuccino', 'hat_flame_crown', 'back_flame_wings']) if (SE.State.grantItem(id)) n++;
                if (n) { SE.State.save(); PIKABU_HUD(); }
            },
        },
        { id: 'no_ads', type: 'non_consumable', icon: '🚫', name: 'Без рекламы', desc: 'Убирает рекламу между раундами навсегда. Награды за рекламу остаются', noAds: true },
    ],
});
