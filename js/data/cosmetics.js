/* =========================================================================
   Steal a Dragon Egg — cosmetics catalog (SE.CosmeticData)

   Pure data + pure helpers, no THREE, no DOM. Loaded after i18n.js (and
   after data/dragons.js when present, for rarity colours/names). The 3D /
   texture / particle builders that turn `build` params into visuals live in
   js/cosmetics.js (SE.Cosmetics).

   TABS        shop tabs [{ id:'outfit'|'hat'|'back'|'trail'|'victory'|'mythic', icon, key, color }]
   SLOTS       equipment slots ['outfit','hat','back','trail','victory'] (State.cosmetics.equipped)
   RARITIES    { common:{ id, color, order, key }, rare, epic, legendary, mythic }
   ITEMS[i]    { id, tab (= equipment slot), shopTab (shop tab), rarity, names:{ ru, en, tr },
                 price:{ gems:N } | { ads:N }     (exclusives: { daily:7 }),
                 exclusive:bool, isDefault:bool, skin:bool, order, build:{ style|fx|skin, … } }
   Mythic "brainrot" skins (user request 2026-10-06): 6 full-body GLB skins, rarity 'mythic',
     shopTab 'mythic', slot (tab) 'outfit' — mutually exclusive with outfits. build:{ skin:true,
     key:'skin.<id>', url:'assets/models/skins/<id>.glb', icons:[render pngs] }. Never on the
     wheel, in the Daily Gift or on bots (wheelPool and shopItems('outfit') exclude them).
   EXCLUSIVE_DAILY   the 4 Daily-Gift day-7 outfits (exclusive:true, never in
                     the shop or on the wheel), one per 7-day cycle in this order.
   DEFAULT_OUTFIT    'outfit_classic' (owned by everyone, price { gems:0 })

   item(id) -> item|null          byTab(shopTab) -> items (exclusives included)
   shopItems(shopTab) -> items    shop list: no exclusives, sorted by rarity (mythic first)
                                  then price (an ad view ~ 50 gems)
   wheelPool(isOwned?) -> items   items that can be won on the wheel / given by the Daily Gift
                                  (no exclusives, no default, no mythic; isOwned(id) filters owned)
   skins() -> mythic skin items   isSkin(item|id)
   name(id) -> localized name     tabName(tab), rarityName(r), rarityColor(r)
   isAd(item|id), isGems(item|id), priceValue(item|id) -> gems or ad views
   exclusiveForCycle(cycle) -> id (cycles through EXCLUSIVE_DAILY)
   count(tab) / all ids: ITEMS.map(i => i.id)

   Pricing (SPEC §7/§8): per tab ≈ 35 % gems (25–600) and ≈ 65 % ads
   (1–5 views; rarer = more). Rarity: common / rare / epic / legendary.
   i18n prefix: cos.* (item names are registered as cos.name.<id>).
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};

  var TABS = [
    { id: 'mythic',  icon: 'sparkles', key: 'cos.tab.mythic', color: '#ff3fb4' },
    { id: 'outfit',  icon: 'shirt',   key: 'cos.tab.outfit',  color: '#3f8fe0' },
    { id: 'hat',     icon: 'hat',     key: 'cos.tab.hat',     color: '#e0563f' },
    { id: 'back',    icon: 'wings',   key: 'cos.tab.back',    color: '#2fa060' },
    { id: 'trail',   icon: 'rainbow', key: 'cos.tab.trail',   color: '#b04fe0' },
    { id: 'victory', icon: 'trophy',  key: 'cos.tab.victory', color: '#e0a400' }
  ];
  var SLOTS = ['outfit', 'hat', 'back', 'trail', 'victory'];

  /* Colours follow the concept rarity palette (SPEC §3.1). */
  var RARITIES = {
    common:    { id: 'common',    color: '#4f9a2a', order: 0, key: 'cos.rarity.common' },
    rare:      { id: 'rare',      color: '#d0781a', order: 1, key: 'cos.rarity.rare' },
    epic:      { id: 'epic',      color: '#7b3fd0', order: 2, key: 'cos.rarity.epic' },
    legendary: { id: 'legendary', color: '#e0a400', order: 3, key: 'cos.rarity.legendary' },
    mythic:    { id: 'mythic',    color: '#ff3fb4', order: 4, key: 'cos.rarity.mythic' }
  };

  var DEFAULT_OUTFIT = 'outfit_classic';
  var EXCLUSIVE_DAILY = ['outfit_dragon_knight', 'outfit_frost_warden', 'outfit_ember_lord', 'outfit_aurora_paladin'];

  function G(n) { return { gems: n }; }
  function A(n) { return { ads: n }; }

  /* [id, rarity, price, ru, en, tr, build] grouped per tab */
  var RAW = {
    outfit: [
      ['outfit_classic',      'common', G(0),   'Классика',              'Classic',            'Klasik',               { style: 'classic' }],
      ['outfit_tamer',        'common', A(1),   'Укротитель драконов',   'Dragon Tamer',       'Ejderha Terbiyecisi',  { style: 'tamer' }],
      ['outfit_scale_hoodie', 'common', G(40),  'Чешуйчатое худи',       'Scale Hoodie',       'Pullu Kapüşonlu',      { style: 'scale_hoodie' }],
      ['outfit_egg_burglar',  'common', A(1),   'Взломщик яиц',          'Egg Burglar',        'Yumurta Hırsızı',      { style: 'burglar' }],
      ['outfit_farmhand',     'common', A(1),   'Работник фермы',        'Farmhand',           'Çiftlik Yardımcısı',   { style: 'farmhand' }],
      ['outfit_explorer',     'common', G(30),  'Исследователь логов',   'Lair Explorer',      'İn Kaşifi',            { style: 'explorer' }],
      ['outfit_sprinter',     'common', A(1),   'Спринтер',              'Sprinter',           'Koşucu',               { style: 'sprinter' }],
      ['outfit_leaf_tunic',   'common', A(2),   'Листовая туника',       'Leaf Tunic',         'Yaprak Tunik',         { style: 'leaf_tunic' }],
      ['outfit_keeper',       'common', A(1),   'Смотритель инкубатора', 'Hatchery Keeper',    'Kuluçka Bekçisi',      { style: 'keeper' }],
      ['outfit_firefighter',  'rare',   A(2),   'Огнеборец',             'Firefighter',        'İtfaiyeci',            { style: 'firefighter' }],
      ['outfit_sky_pirate',   'rare',   A(2),   'Небесный пират',        'Sky Pirate',         'Gök Korsanı',          { style: 'pirate' }],
      ['outfit_ninja',        'rare',   G(120), 'Ниндзя тени',           'Shadow Ninja',       'Gölge Ninja',          { style: 'ninja' }],
      ['outfit_mage',         'rare',   A(2),   'Драконий маг',          'Dragon Mage',        'Ejderha Büyücüsü',     { style: 'mage' }],
      ['outfit_viking',       'rare',   A(3),   'Викинг-наездник',       'Viking Rider',       'Viking Binici',        { style: 'viking' }],
      ['outfit_knight',       'rare',   G(150), 'Рыцарь гнезда',         'Nest Knight',        'Yuva Şövalyesi',       { style: 'knight' }],
      ['outfit_druid',        'rare',   A(2),   'Мшистый друид',         'Moss Druid',         'Yosun Druidi',         { style: 'druid' }],
      ['outfit_nomad',        'rare',   A(2),   'Странник дюн',          'Dune Nomad',         'Kumul Göçebesi',       { style: 'nomad' }],
      ['outfit_astronaut',    'rare',   G(100), 'Космонавт',             'Astronaut',          'Astronot',             { style: 'astronaut' }],
      ['outfit_rainbow',      'rare',   A(3),   'Радужное худи',         'Rainbow Hoodie',     'Gökkuşağı Kapüşonlu',  { style: 'rainbow' }],
      ['outfit_samurai',      'epic',   A(3),   'Самурай-дракон',        'Dragon Samurai',     'Ejderha Samuray',      { style: 'samurai' }],
      ['outfit_onesie',       'epic',   G(250), 'Пижама-дракон',         'Dragon Onesie',      'Ejderha Tulumu',       { style: 'onesie' }],
      ['outfit_frost_robe',   'epic',   A(4),   'Ледяная мантия',        'Frost Robe',         'Buz Cübbesi',          { style: 'frost_robe' }],
      ['outfit_lava',         'epic',   A(4),   'Лавовая броня',         'Lava Armor',         'Lav Zırhı',            { style: 'lava' }],
      ['outfit_tinker',       'epic',   G(220), 'Часовщик-изобретатель', 'Clockwork Tinker',   'Çarklı Mucit',         { style: 'tinker' }],
      ['outfit_bone',         'epic',   A(3),   'Костяной дракон',       'Bone Dragon',        'Kemik Ejderha',        { style: 'bone' }],
      ['outfit_royal',        'epic',   G(300), 'Королевская мантия',    'Royal Robe',         'Kraliyet Cübbesi',     { style: 'royal' }],
      ['outfit_storm',        'legendary', A(5),   'Грозовой страж',     'Storm Guard',        'Fırtına Muhafızı',     { style: 'storm' }],
      ['outfit_crystal',      'legendary', G(450), 'Кристальный доспех', 'Crystal Armor',      'Kristal Zırh',         { style: 'crystal' }],
      ['outfit_hoard',        'legendary', A(5),   'Хранитель сокровищ', 'Hoard Keeper',       'Hazine Bekçisi',       { style: 'hoard' }],
      ['outfit_galaxy',       'legendary', G(600), 'Галактический костюм', 'Galaxy Suit',      'Galaksi Kıyafeti',     { style: 'galaxy' }],
      /* Daily Gift exclusives (day 7), never sold */
      ['outfit_dragon_knight',  'legendary', { daily: 7 }, 'Рыцарь-дракон',   'Dragon Knight',   'Ejderha Şövalyesi', { style: 'dragon_knight' }],
      ['outfit_frost_warden',   'legendary', { daily: 7 }, 'Ледяной страж',   'Frost Warden',    'Buz Muhafızı',      { style: 'frost_warden' }],
      ['outfit_ember_lord',     'legendary', { daily: 7 }, 'Повелитель углей', 'Ember Lord',     'Kor Lordu',         { style: 'ember_lord' }],
      ['outfit_aurora_paladin', 'legendary', { daily: 7 }, 'Паладин Авроры',  'Aurora Paladin',  'Aurora Paladini',   { style: 'aurora_paladin' }]
    ],
    hat: [
      ['hat_beanie',       'common', G(25),  'Шапка с помпоном',     'Pom Beanie',         'Ponponlu Bere',        { style: 'beanie' }],
      ['hat_party',        'common', A(1),   'Праздничный колпак',   'Party Hat',          'Parti Şapkası',        { style: 'party' }],
      ['hat_chef',         'common', G(35),  'Колпак повара',        'Chef Hat',           'Aşçı Şapkası',         { style: 'chef' }],
      ['hat_bandana',      'common', A(1),   'Бандана ниндзя',       'Ninja Bandana',      'Ninja Bandanası',      { style: 'bandana' }],
      ['hat_cowboy',       'common', G(40),  'Шляпа ковбоя',         'Cowboy Hat',         'Kovboy Şapkası',       { style: 'cowboy' }],
      ['hat_propeller',    'common', A(1),   'Кепка с пропеллером',  'Propeller Cap',      'Pervaneli Şapka',      { style: 'propeller' }],
      ['hat_mushroom',     'common', A(2),   'Грибная шляпка',       'Mushroom Cap',       'Mantar Şapka',         { style: 'mushroom' }],
      ['hat_eggshell',     'common', A(1),   'Скорлупка',            'Eggshell Hat',       'Yumurta Kabuğu',       { style: 'eggshell' }],
      ['hat_tamer_helm',   'rare',   A(2),   'Шлем укротителя',      'Tamer\'s Helm',      'Terbiyeci Kaskı',      { style: 'tamer_helm' }],
      ['hat_viking',       'rare',   A(2),   'Рогатый шлем',         'Viking Helm',        'Viking Miğferi',       { style: 'viking' }],
      ['hat_wizard',       'rare',   G(100), 'Шляпа волшебника',     'Wizard Hat',         'Büyücü Şapkası',       { style: 'wizard' }],
      ['hat_pirate',       'rare',   A(2),   'Треуголка пирата',     'Pirate Tricorn',     'Korsan Şapkası',       { style: 'pirate' }],
      ['hat_top_hat',      'rare',   G(90),  'Цилиндр',              'Top Hat',            'Silindir Şapka',       { style: 'top_hat' }],
      ['hat_horns',        'rare',   A(2),   'Драконьи рога',        'Dragon Horns',       'Ejderha Boynuzları',   { style: 'horns' }],
      ['hat_antlers',      'rare',   A(3),   'Ветвистые рога',       'Mossy Antlers',      'Yosunlu Boynuzlar',    { style: 'antlers' }],
      ['hat_headphones',   'rare',   G(80),  'Наушники',             'Headphones',         'Kulaklık',             { style: 'headphones' }],
      ['hat_feather_cap',  'rare',   A(2),   'Шапка с пером',        'Feather Cap',        'Tüylü Şapka',          { style: 'feather_cap' }],
      ['hat_nest',         'rare',   A(3),   'Гнездо на голове',     'Nest Hat',           'Yuva Şapka',           { style: 'nest' }],
      ['hat_astronaut',    'rare',   G(120), 'Шлем космонавта',      'Space Helmet',       'Uzay Kaskı',           { style: 'astronaut' }],
      ['hat_dragon_hood',  'epic',   A(4),   'Капюшон-дракон',       'Dragon Hood',        'Ejderha Başlığı',      { style: 'dragon_hood' }],
      ['hat_knight',       'epic',   G(220), 'Шлем рыцаря',          'Knight Helm',        'Şövalye Miğferi',      { style: 'knight' }],
      ['hat_samurai',      'epic',   A(3),   'Кабуто самурая',       'Samurai Kabuto',     'Samuray Kabutosu',     { style: 'samurai' }],
      ['hat_crown',        'epic',   G(300), 'Королевская корона',   'Royal Crown',        'Kraliyet Tacı',        { style: 'crown' }],
      ['hat_ice_crown',    'epic',   A(4),   'Ледяная корона',       'Ice Crown',          'Buz Tacı',             { style: 'ice_crown' }],
      ['hat_dragon_skull', 'epic',   A(4),   'Череп дракона',        'Dragon Skull',       'Ejderha Kafatası',     { style: 'dragon_skull' }],
      ['hat_jester',       'epic',   A(3),   'Колпак шута',          'Jester Hat',         'Soytarı Şapkası',      { style: 'jester' }],
      ['hat_flame_crown',  'legendary', A(5),   'Пламенная корона',  'Flame Crown',        'Alev Tacı',            { style: 'flame_crown' }],
      ['hat_halo',         'legendary', G(500), 'Нимб Авроры',       'Aurora Halo',        'Aurora Halesi',        { style: 'halo' }],
      ['hat_baby_dragon',  'legendary', A(5),   'Дракончик на голове', 'Baby Dragon Buddy', 'Yavru Ejderha Dostu', { style: 'baby_dragon' }],
      ['hat_storm_cloud',  'legendary', G(600), 'Грозовая тучка',    'Storm Cloud',        'Fırtına Bulutu',       { style: 'storm_cloud' }]
    ],
    back: [
      ['back_cape_red',       'common', G(30),  'Плащ героя',            'Hero Cape',          'Kahraman Pelerini',    { style: 'cape', color: '#d8322a', trim: '#ffd24a' }],
      ['back_quiver',         'common', A(1),   'Колчан',                'Quiver',             'Okluk',                { style: 'quiver' }],
      ['back_egg_basket',     'common', A(1),   'Корзина для яиц',       'Egg Basket',         'Yumurta Sepeti',       { style: 'egg_basket' }],
      ['back_shield',         'common', A(1),   'Щит с драконом',        'Dragon Shield',      'Ejderha Kalkanı',      { style: 'shield' }],
      ['back_bat_wings',      'common', A(2),   'Крылья летучей мыши',   'Bat Wings',          'Yarasa Kanatları',     { style: 'bat_wings' }],
      ['back_banner',         'common', G(50),  'Знамя логова',          'Lair Banner',        'İn Sancağı',           { style: 'banner' }],
      ['back_meadow_wings',   'rare',   A(2),   'Луговые крылья',        'Meadow Wings',       'Çayır Kanatları',      { style: 'dragon_wings', kind: 'meadow' }],
      ['back_fairy_wings',    'rare',   G(120), 'Крылья феи',            'Fairy Wings',        'Peri Kanatları',       { style: 'fairy_wings' }],
      ['back_treasure_sack',  'rare',   A(2),   'Мешок с добычей',       'Loot Sack',          'Ganimet Çuvalı',       { style: 'treasure_sack' }],
      ['back_guitar',         'rare',   G(90),  'Гитара барда',          'Bard Guitar',        'Ozan Gitarı',          { style: 'guitar' }],
      ['back_dragon_tail',    'rare',   A(3),   'Драконий хвост',        'Dragon Tail',        'Ejderha Kuyruğu',      { style: 'dragon_tail' }],
      ['back_plush_dragon',   'rare',   A(2),   'Рюкзак-дракончик',      'Plush Dragon Pack',  'Pelüş Ejderha Çanta',  { style: 'plush_dragon' }],
      ['back_lantern',        'rare',   A(2),   'Фонарь странника',      'Wanderer Lantern',   'Gezgin Feneri',        { style: 'lantern' }],
      ['back_sword',          'rare',   G(140), 'Меч из драконьей кости', 'Dragonbone Sword',  'Ejderha Kemiği Kılıç', { style: 'sword' }],
      ['back_ember_wings',    'epic',   A(4),   'Крылья Пеплопасти',     'Embermaw Wings',     'Kor Kanatları',        { style: 'dragon_wings', kind: 'ember' }],
      ['back_frost_wings',    'epic',   A(4),   'Крылья Ледоклыка',      'Frostfang Wings',    'Buz Dişi Kanatları',   { style: 'dragon_wings', kind: 'frost' }],
      ['back_mosswood_wings', 'epic',   A(3),   'Лиственные крылья',     'Mosswood Wings',     'Yosun Kanatları',      { style: 'leaf_wings' }],
      ['back_angel_wings',    'epic',   G(280), 'Крылья ангела',         'Angel Wings',        'Melek Kanatları',      { style: 'angel_wings' }],
      ['back_jetpack',        'epic',   G(250), 'Реактивный ранец',      'Jetpack',            'Jetpack',              { style: 'jetpack' }],
      ['back_cape_royal',     'epic',   A(3),   'Королевский плащ',      'Royal Cape',         'Kraliyet Pelerini',    { style: 'cape', color: '#6a2bb8', trim: '#fff7e8', ermine: true }],
      ['back_clockwork_wings', 'epic',  A(4),   'Механические крылья',   'Clockwork Wings',    'Çarklı Kanatlar',      { style: 'clockwork_wings' }],
      ['back_aurora_wings',   'legendary', G(550), 'Крылья Авроры',      'Aurora Wings',       'Aurora Kanatları',     { style: 'dragon_wings', kind: 'aurora' }],
      ['back_flame_wings',    'legendary', A(5),   'Огненные крылья',    'Flame Wings',        'Alev Kanatları',       { style: 'flame_wings' }],
      ['back_crystal_wings',  'legendary', A(5),   'Кристальные крылья', 'Crystal Wings',      'Kristal Kanatlar',     { style: 'crystal_wings' }]
    ],
    trail: [
      ['trail_sparkle',     'common', A(1),   'Искорки',             'Sparkles',           'Pırıltılar',           { fx: 'sparkle' }],
      ['trail_leaves',      'common', G(25),  'Листопад',            'Falling Leaves',     'Yaprak Dökümü',        { fx: 'leaves' }],
      ['trail_bubbles',     'common', A(1),   'Пузыри',              'Bubbles',            'Baloncuklar',          { fx: 'bubbles' }],
      ['trail_smoke',       'common', A(1),   'Дымок',               'Smoke Puffs',        'Duman',                { fx: 'smoke' }],
      ['trail_hearts',      'common', G(40),  'Сердечки',            'Hearts',             'Kalpler',              { fx: 'hearts' }],
      ['trail_footprints',  'common', A(1),   'Следы дракона',       'Dragon Tracks',      'Ejderha İzleri',       { fx: 'footprints' }],
      ['trail_confetti',    'common', A(2),   'Конфетти',            'Confetti',           'Konfeti',              { fx: 'confetti' }],
      ['trail_fire',        'rare',   A(2),   'Огонь',               'Fire',               'Ateş',                 { fx: 'fire' }],
      ['trail_frost',       'rare',   A(2),   'Иней',                'Frost',              'Kırağı',               { fx: 'frost' }],
      ['trail_stars',       'rare',   G(100), 'Звёзды',              'Stars',              'Yıldızlar',            { fx: 'stars' }],
      ['trail_notes',       'rare',   A(2),   'Музыка',              'Music Notes',        'Notalar',              { fx: 'notes' }],
      ['trail_petals',      'rare',   A(2),   'Лепестки',            'Petals',             'Taç Yapraklar',        { fx: 'petals' }],
      ['trail_snow',        'rare',   G(80),  'Снегопад',            'Snowfall',           'Kar Yağışı',           { fx: 'snow' }],
      ['trail_coins',       'rare',   A(3),   'Золотые монеты',      'Gold Coins',         'Altın Paralar',        { fx: 'coins' }],
      ['trail_pixels',      'rare',   G(90),  'Пиксели',             'Pixels',             'Pikseller',            { fx: 'pixels' }],
      ['trail_slime',       'rare',   A(2),   'Слизь',               'Slime',              'Balçık',               { fx: 'slime' }],
      ['trail_rainbow',     'epic',   A(4),   'Радужная лента',      'Rainbow Ribbon',     'Gökkuşağı Kurdelesi',  { fx: 'rainbow' }],
      ['trail_embers',      'epic',   A(3),   'Угольки',             'Embers',             'Korlar',               { fx: 'embers' }],
      ['trail_lightning',   'epic',   G(250), 'Молнии',              'Lightning',          'Şimşekler',            { fx: 'lightning' }],
      ['trail_gems',        'epic',   A(4),   'Самоцветы',           'Gem Shards',         'Mücevher Parçaları',   { fx: 'gems' }],
      ['trail_runes',       'epic',   G(300), 'Магические руны',     'Magic Runes',        'Büyülü Rünler',        { fx: 'runes' }],
      ['trail_butterflies', 'epic',   A(3),   'Бабочки',             'Butterflies',        'Kelebekler',           { fx: 'butterflies' }],
      ['trail_galaxy',      'legendary', A(5),   'Галактика',        'Galaxy',             'Galaksi',              { fx: 'galaxy' }],
      ['trail_dragonfire',  'legendary', G(550), 'Драконье пламя',   'Dragonfire',         'Ejderha Alevi',        { fx: 'dragonfire' }]
    ],
    victory: [
      ['victory_confetti',     'common', A(1),   'Конфетти-пушка',       'Confetti Cannon',    'Konfeti Topu',         { fx: 'confetti' }],
      ['victory_hearts',       'common', G(30),  'Фонтан сердец',        'Heart Fountain',     'Kalp Çeşmesi',         { fx: 'hearts' }],
      ['victory_bubbles',      'common', A(1),   'Пузырьковый взрыв',    'Bubble Pop',         'Baloncuk Patlaması',   { fx: 'bubbles' }],
      ['victory_balloons',     'common', A(2),   'Воздушные шары',       'Balloons',           'Balonlar',             { fx: 'balloons' }],
      ['victory_flowers',      'common', A(1),   'Цветочная поляна',     'Flower Bloom',       'Çiçek Açması',         { fx: 'flowers' }],
      ['victory_fireworks',    'rare',   G(120), 'Фейерверк',            'Fireworks',          'Havai Fişek',          { fx: 'fireworks' }],
      ['victory_coin_rain',    'rare',   A(2),   'Денежный дождь',       'Coin Rain',          'Para Yağmuru',         { fx: 'coin_rain' }],
      ['victory_star_burst',   'rare',   A(2),   'Звёздный взрыв',       'Star Burst',         'Yıldız Patlaması',     { fx: 'star_burst' }],
      ['victory_snow_nova',    'rare',   A(3),   'Ледяная вспышка',      'Frost Nova',         'Buz Patlaması',        { fx: 'snow_nova' }],
      ['victory_magic_circle', 'rare',   G(100), 'Магический круг',      'Magic Circle',       'Büyü Çemberi',         { fx: 'magic_circle' }],
      ['victory_rainbow',      'rare',   A(3),   'Радуга',               'Rainbow Arc',        'Gökkuşağı',            { fx: 'rainbow' }],
      ['victory_roar',         'epic',   A(4),   'Рёв дракона',          'Dragon Roar',        'Ejderha Kükremesi',    { fx: 'roar' }],
      ['victory_lightning',    'epic',   G(250), 'Удар молнии',          'Lightning Strike',   'Yıldırım Çarpması',    { fx: 'lightning' }],
      ['victory_gem_fountain', 'epic',   A(3),   'Фонтан самоцветов',    'Gem Fountain',       'Mücevher Çeşmesi',     { fx: 'gem_fountain' }],
      ['victory_flame_ring',   'epic',   A(4),   'Огненный вихрь',       'Flame Tornado',      'Alev Hortumu',         { fx: 'flame_ring' }],
      ['victory_meteors',      'epic',   G(300), 'Метеоритный дождь',    'Meteor Shower',      'Meteor Yağmuru',       { fx: 'meteors' }],
      ['victory_gold_pillar',  'legendary', G(500), 'Золотой столп',     'Golden Pillar',      'Altın Sütun',          { fx: 'gold_pillar' }],
      ['victory_dragon_flyby', 'legendary', G(600), 'Пролёт дракона',    'Dragon Flyby',       'Ejderha Geçişi',       { fx: 'dragon_flyby' }],
      ['victory_aurora',       'legendary', A(5),   'Северное сияние',   'Aurora Lights',      'Kutup Işıkları',       { fx: 'aurora' }],
      ['victory_egg_hatch',    'legendary', A(5),   'Великое вылупление', 'Grand Hatching',    'Büyük Çatlama',        { fx: 'egg_hatch' }]
    ],
    /* Mythic full-body skins (slot 'outfit', shop tab 'mythic') */
    mythic: [
      ['skin_67',         'mythic', A(6),    'Скин 67',                '67',                    '67',                      { skin: true }],
      ['skin_tungtung',   'mythic', A(3),    'Тунг-Тунг Яйцо Сахур',   'Tung-Tung Egg Sahur',   'Tung-Tung Yumurta Sahur', { skin: true }],
      ['skin_bananini',   'mythic', A(5),    'Бананини Драконини',     'Bananini Dragonini',    'Bananini Ejderini',       { skin: true }],
      ['skin_cappuccino', 'mythic', A(7),    'Капучино Драгонино',     'Cappuccino Dragonino',  'Kapuçino Ejderino',       { skin: true }],
      ['skin_dragonello', 'mythic', G(2500), 'Драгонелло Кроссовкино', 'Dragonello Sneakerino', 'Ejderello Sporcuno',      { skin: true }],
      /* pose: arm-rotation factors of the character's carry / celebrate / walk poses (1 = as the blocky character).
         Lirili's arms already point up and Bombardino's "arms" are plane wings: they keep their rest pose. */
      ['skin_lirili',     'mythic', G(4000), 'Лирили Ларидрако',       'Lirili Laridraco',      'Lirili Laridrako',        { skin: true, pose: { carry: 0, celebrate: 0.12, walk: 0.45, flap: 0.18 } }],
      ['skin_bombardino', 'mythic', G(6000), 'Бомбардино Дракодилло',  'Bombardino Dracodillo', 'Bombardino Drakodillo',   { skin: true, pose: { carry: 0, celebrate: 0, walk: 0.12, flap: 0.22 } }]
    ]
  };

  var ITEMS = [];
  var BY_ID = {};
  var BY_TAB = {};
  var order = 0;
  TABS.forEach(function (tab) {
    BY_TAB[tab.id] = [];
    RAW[tab.id].forEach(function (r) {
      var skin = !!(r[6] && r[6].skin);
      var it = {
        id: r[0], tab: skin ? 'outfit' : tab.id, shopTab: tab.id, rarity: r[1], price: r[2],
        names: { ru: r[3], en: r[4], tr: r[5] },
        exclusive: EXCLUSIVE_DAILY.indexOf(r[0]) >= 0,
        isDefault: r[0] === DEFAULT_OUTFIT,
        skin: skin,
        order: order++,
        build: r[6]
      };
      if (skin) {
        var short = r[0].replace(/^skin_/, '');
        it.build = { skin: true, key: 'skin.' + r[0], url: 'assets/models/skins/' + r[0] + '.glb',
          altUrl: 'assets/models/skins/' + short + '.glb',
          icons: ['assets/ui/render/skin-' + r[0] + '.png', 'assets/ui/render/skin-' + short + '.png'],
          pose: r[6].pose || null };
      }
      ITEMS.push(it);
      BY_ID[it.id] = it;
      BY_TAB[tab.id].push(it);
    });
  });

  function lang() { return (SE.I18N && SE.I18N.lang) || 'en'; }
  function tr(key, fb) {
    if (SE.t) { var s = SE.t(key); if (s && s !== key) return s; }
    return fb !== undefined ? fb : key;
  }
  function asItem(x) { return typeof x === 'string' ? BY_ID[x] || null : x || null; }
  /* rarity (common -> legendary; mythic first), then price (an ad view ~ 50 gems), then catalogue order */
  function cost(it) { return it.price ? (it.price.ads ? it.price.ads * 50 : it.price.gems || 0) : 0; }
  function sortShop(a, b) {
    var ra = a.rarity === 'mythic' ? -1 : RARITIES[a.rarity].order, rb = b.rarity === 'mythic' ? -1 : RARITIES[b.rarity].order;
    if (ra !== rb) return ra - rb;
    if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? -1 : 1;
    var ca = cost(a), cb = cost(b);
    if (ca !== cb) return ca - cb;
    return a.order - b.order;
  }

  var CosmeticData = {
    TABS: TABS,
    RARITIES: RARITIES,
    ITEMS: ITEMS,
    EXCLUSIVE_DAILY: EXCLUSIVE_DAILY,
    DEFAULT_OUTFIT: DEFAULT_OUTFIT,
    SLOTS: SLOTS,

    item: function (id) { return (typeof id === 'string' && BY_ID[id]) || null; },
    byTab: function (tab) { return (BY_TAB[tab] || []).slice(); },
    shopItems: function (tab) {
      return (BY_TAB[tab] || []).filter(function (it) { return !it.exclusive; }).sort(sortShop);
    },
    wheelPool: function (isOwned) {
      return ITEMS.filter(function (it) {
        return !it.exclusive && !it.isDefault && !it.skin && it.rarity !== 'mythic' && !(isOwned && isOwned(it.id));
      });
    },
    skins: function () { return (BY_TAB.mythic || []).slice(); },
    isSkin: function (x) { var it = asItem(x); return !!(it && it.skin); },
    count: function (tab) { return tab ? (BY_TAB[tab] || []).length : ITEMS.length; },
    name: function (id) {
      var it = BY_ID[id];
      if (!it) return String(id || '');
      return tr('cos.name.' + id, it.names[lang()] || it.names.en);
    },
    tabName: function (tab) { return tr('cos.tab.' + tab, tab); },
    rarityName: function (r) { return RARITIES[r] ? tr(RARITIES[r].key, r) : ''; },
    rarityColor: function (r) { return RARITIES[r] ? RARITIES[r].color : '#888888'; },
    isAd: function (x) { var it = asItem(x); return !!(it && it.price && it.price.ads); },
    isGems: function (x) { var it = asItem(x); return !!(it && it.price && it.price.gems !== undefined); },
    priceValue: function (x) {
      var it = asItem(x);
      if (!it || !it.price) return 0;
      return it.price.ads || it.price.gems || 0;
    },
    exclusiveForCycle: function (cycle) {
      var n = EXCLUSIVE_DAILY.length;
      var c = Math.max(0, Math.floor(+cycle || 0));
      return EXCLUSIVE_DAILY[c % n];
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Strings                                                                 */
  /* ---------------------------------------------------------------------- */
  if (SE.I18N && SE.I18N.add) {
    var dict = {
      ru: {
        'cos.tab.outfit': 'Одежда', 'cos.tab.hat': 'Шапки', 'cos.tab.back': 'На спину',
        'cos.tab.trail': 'Следы', 'cos.tab.victory': 'Победа', 'cos.tab.mythic': 'Мифические', 'cos.rarity.mythic': 'Мифический',
        'cos.rarity.common': 'Обычный', 'cos.rarity.rare': 'Редкий',
        'cos.rarity.epic': 'Эпический', 'cos.rarity.legendary': 'Легендарный',
        'cos.exclusive': 'Эксклюзив', 'cos.default': 'Стандарт'
      },
      en: {
        'cos.tab.outfit': 'Outfits', 'cos.tab.hat': 'Hats', 'cos.tab.back': 'Back',
        'cos.tab.trail': 'Trails', 'cos.tab.victory': 'Victory', 'cos.tab.mythic': 'Mythic', 'cos.rarity.mythic': 'Mythic',
        'cos.rarity.common': 'Common', 'cos.rarity.rare': 'Rare',
        'cos.rarity.epic': 'Epic', 'cos.rarity.legendary': 'Legendary',
        'cos.exclusive': 'Exclusive', 'cos.default': 'Default'
      },
      tr: {
        'cos.tab.outfit': 'Kıyafetler', 'cos.tab.hat': 'Şapkalar', 'cos.tab.back': 'Sırt',
        'cos.tab.trail': 'İzler', 'cos.tab.victory': 'Zafer', 'cos.tab.mythic': 'Mitik', 'cos.rarity.mythic': 'Mitik',
        'cos.rarity.common': 'Yaygın', 'cos.rarity.rare': 'Nadir',
        'cos.rarity.epic': 'Destansı', 'cos.rarity.legendary': 'Efsanevi',
        'cos.exclusive': 'Özel', 'cos.default': 'Varsayılan'
      }
    };
    ITEMS.forEach(function (it) {
      dict.ru['cos.name.' + it.id] = it.names.ru;
      dict.en['cos.name.' + it.id] = it.names.en;
      dict.tr['cos.name.' + it.id] = it.names.tr;
    });
    SE.I18N.add(dict);
  }

  SE.CosmeticData = CosmeticData;
})(typeof window !== 'undefined' ? window : globalThis);
