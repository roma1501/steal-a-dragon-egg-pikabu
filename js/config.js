/* =====================================================================
   SE.Config — build-time configuration (docs/SPEC.md §7, docs/PLATFORMS.md).

   Loaded right after the Three.js libs and BEFORE the platform adapter.
   Every line tagged "@build <KEY>" is rewritten by tools/build.mjs for the
   release builds (dist/<platform>/js/config.js); the source file always
   stays the local-dev configuration. Keep each tagged entry on ONE line,
   in the form  KEY: <value>,  // @build KEY   (the build fails loudly when
   a tag is missing or malformed).

   PLATFORM  'local' | 'playgama' | 'yandex' | 'playables'
   LANG      null → the adapter decides (local: ?lang= or 'ru'; playgama:
             platform language; yandex: 'ru'; playables: 'en');
             'ru' | 'en' | 'tr' forces a language; 'auto' → SDK language.
   DEBUG     enables window.SE_TEST hooks (§11). Release builds: false
             (node tools/build.mjs <p> --debug keeps the ?debug URL flag).
   MOCK_ADS  local adapter only: fake ad overlay (?mockads, ?mockads=fail).
   ADS       false hides every ad offer on every platform (build --no-ads).
   ===================================================================== */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};

  /* SPEC §13: colour management on before ANY colour / material is created — this is the first
     game script after the Three.js libs, so every module (and every dev lab) sees sRGB → linear. */
  if (global.THREE && global.THREE.ColorManagement) global.THREE.ColorManagement.enabled = true;

  var query = '';
  try { query = String((global.location && global.location.search) || ''); } catch (e) { query = ''; }

  function flag(name) {
    return new RegExp('[?&]' + name + '(?:[=&#]|$)').test(query);
  }

  SE.Config = {
    GAME_ID: 'steal-a-dragon-egg',
    VERSION: '1.0.2',
    PLATFORM: "pikabu",              // @build PLATFORM
    LANG: "ru",                     // @build LANG
    DEBUG: false,           // @build DEBUG
    MOCK_ADS: false,      // @build MOCK_ADS
    ADS: true,                      // @build ADS
    BUILD: "pikabu 1.0.2 2026-11-05T17:51Z"                    // @build BUILD
  };
})(window);
