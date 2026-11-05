/* =========================================================
   Утилиты: числа, время, случайности, канвас-текстуры
   ========================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};

  var SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp'];

  var U = {
    clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    damp: function (a, b, lambda, dt) { return U.lerp(a, b, 1 - Math.exp(-lambda * dt)); },
    rand: function (a, b) { return a + Math.random() * (b - a); },
    randInt: function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); },
    choice: function (arr) { return arr[Math.floor(Math.random() * arr.length)]; },

    /* Детерминированный генератор — для одинаковой генерации мира */
    seeded: function (seed) {
      var s = seed >>> 0;
      return function () {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
    },

    /* $400 / $12.5K / $3.4M */
    money: function (n) {
      return '$' + U.shortNum(n);
    },

    shortNum: function (n) {
      n = Math.floor(n || 0);
      if (n < 1000) return String(n);
      var i = 0;
      var v = n;
      while (v >= 1000 && i < SUFFIX.length - 1) { v /= 1000; i++; }
      var s = v >= 100 ? v.toFixed(0) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
      s = s.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
      return s + SUFFIX[i];
    },

    /* 4 мин. 35 сек. */
    time: function (sec) {
      sec = Math.max(0, Math.ceil(sec));
      var lang = (SE.I18N && SE.I18N.lang) || 'ru';
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      var h = Math.floor(m / 60);
      var L = {
        ru: { h: 'ч.', m: 'мин.', s: 'сек.' },
        en: { h: 'h', m: 'min', s: 'sec' },
        tr: { h: 'sa', m: 'dk', s: 'sn' }
      }[lang] || { h: 'h', m: 'min', s: 'sec' };
      if (h > 0) return h + ' ' + L.h + ' ' + (m % 60) + ' ' + L.m;
      if (m > 0) return m + ' ' + L.m + ' ' + s + ' ' + L.s;
      return s + ' ' + L.s;
    },

    timeShort: function (sec) {
      sec = Math.max(0, Math.ceil(sec));
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      return m + ':' + (s < 10 ? '0' : '') + s;
    },

    /* --------- Канвас-текстуры --------- */
    canvas: function (w, h) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    },

    /* Плита с "пупырышками" как в блочных играх */
    studTexture: function (base, dark, size, cells) {
      size = size || 256; cells = cells || 4;
      var c = U.canvas(size, size);
      var g = c.getContext('2d');
      g.fillStyle = base;
      g.fillRect(0, 0, size, size);
      var cell = size / cells;
      for (var y = 0; y < cells; y++) {
        for (var x = 0; x < cells; x++) {
          var cx = x * cell + cell / 2;
          var cy = y * cell + cell / 2;
          var r = cell * 0.21;
          /* тень */
          g.fillStyle = dark;
          g.globalAlpha = 0.5;
          g.fillRect(cx - r + cell * 0.05, cy - r + cell * 0.06, r * 2, r * 2);
          /* сам стад */
          g.globalAlpha = 1;
          g.fillStyle = base;
          g.fillRect(cx - r, cy - r, r * 2, r * 2);
          /* блик */
          g.globalAlpha = 0.22;
          g.fillStyle = '#ffffff';
          g.fillRect(cx - r, cy - r, r * 2, cell * 0.05);
          g.fillRect(cx - r, cy - r, cell * 0.05, r * 2);
          g.globalAlpha = 1;
          /* тонкая сетка */
          g.strokeStyle = dark;
          g.globalAlpha = 0.18;
          g.strokeRect(x * cell, y * cell, cell, cell);
          g.globalAlpha = 1;
        }
      }
      return c;
    },

    /* Кирпичная стена-ограждение мира */
    brickTexture: function (base, dark, light) {
      var size = 256;
      var c = U.canvas(size, size);
      var g = c.getContext('2d');
      g.fillStyle = base;
      g.fillRect(0, 0, size, size);
      var rows = 8, cols = 4;
      var bh = size / rows, bw = size / cols;
      for (var y = 0; y < rows; y++) {
        var off = (y % 2) * bw / 2;
        for (var x = -1; x < cols + 1; x++) {
          var px = x * bw + off, py = y * bh;
          g.fillStyle = base;
          g.fillRect(px + 2, py + 2, bw - 4, bh - 4);
          g.fillStyle = light;
          g.globalAlpha = 0.25;
          g.fillRect(px + 2, py + 2, bw - 4, 3);
          g.globalAlpha = 1;
          g.strokeStyle = dark;
          g.lineWidth = 3;
          g.strokeRect(px + 2, py + 2, bw - 4, bh - 4);
        }
      }
      return c;
    },

    /* Текстовая вывеска (для 3D-табличек) */
    signTexture: function (text, opt) {
      opt = opt || {};
      var w = opt.width || 512, h = opt.height || 128;
      var c = U.canvas(w, h);
      var g = c.getContext('2d');
      g.clearRect(0, 0, w, h);
      var fs = opt.fontSize || Math.floor(h * 0.55);
      g.font = '900 ' + fs + 'px Nunito, Arial Black, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';

      /* подложка */
      if (opt.bg) {
        var r = opt.radius === undefined ? 22 : opt.radius;
        U.roundRect(g, 4, 4, w - 8, h - 8, r);
        g.fillStyle = opt.bg;
        g.fill();
        if (opt.border) {
          g.lineWidth = opt.borderWidth || 8;
          g.strokeStyle = opt.border;
          g.stroke();
        }
      }

      var lines = String(text).split('\n');
      var padding = (opt.outlineWidth || Math.max(6, fs * 0.16)) + 12;
      var maxWidth = Math.max(1, w - padding * 2);
      var measured = 1;
      for (var line = 0; line < lines.length; line++) measured = Math.max(measured, g.measureText(lines[line]).width);
      fs *= Math.min(1, maxWidth / measured, (h - padding * 2) / (lines.length * fs * 1.05));
      g.font = '900 ' + Math.max(10, fs) + 'px Nunito, Arial Black, sans-serif';
      var lh = fs * 1.05;
      var startY = h / 2 - (lines.length - 1) * lh / 2;
      for (var i = 0; i < lines.length; i++) {
        var y = startY + i * lh;
        if (opt.outline !== false) {
          g.lineWidth = opt.outlineWidth || Math.max(6, fs * 0.16);
          g.strokeStyle = opt.outlineColor || '#241503';
          g.lineJoin = 'round';
          g.miterLimit = 2;
          g.strokeText(lines[i], w / 2, y);
        }
        g.fillStyle = opt.color || '#ffffff';
        g.fillText(lines[i], w / 2, y);
      }
      return c;
    },

    roundRect: function (g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.lineTo(x + w - r, y);
      g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, y + h - r);
      g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      g.lineTo(x + r, y + h);
      g.quadraticCurveTo(x, y + h, x, y + h - r);
      g.lineTo(x, y + r);
      g.quadraticCurveTo(x, y, x + r, y);
      g.closePath();
    },

    /* Лицо персонажа в блочном стиле */
    faceTexture: function () {
      var s = 128;
      var c = U.canvas(s, s);
      var g = c.getContext('2d');
      g.fillStyle = '#f8c471';
      g.fillRect(0, 0, s, s);
      g.fillStyle = '#2b2b2b';
      g.beginPath(); g.ellipse(s * 0.33, s * 0.42, s * 0.06, s * 0.09, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(s * 0.67, s * 0.42, s * 0.06, s * 0.09, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath(); g.ellipse(s * 0.31, s * 0.39, s * 0.02, s * 0.03, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(s * 0.65, s * 0.39, s * 0.02, s * 0.03, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#2b2b2b';
      g.lineWidth = s * 0.045;
      g.lineCap = 'round';
      g.beginPath();
      g.arc(s * 0.5, s * 0.58, s * 0.17, 0.15 * Math.PI, 0.85 * Math.PI);
      g.stroke();
      return c;
    },

    /* Мордочка животного (для питомцев/охранников) */
    animalFace: function (bg, eye) {
      var s = 64;
      var c = U.canvas(s, s);
      var g = c.getContext('2d');
      g.fillStyle = bg;
      g.fillRect(0, 0, s, s);
      g.fillStyle = eye || '#1a1a1a';
      g.fillRect(s * 0.2, s * 0.32, s * 0.14, s * 0.2);
      g.fillRect(s * 0.66, s * 0.32, s * 0.14, s * 0.2);
      return c;
    },

    hex: function (h) { return parseInt(h.replace('#', ''), 16); },

    /* DOM helpers */
    el: function (tag, cls, html) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (html !== undefined) e.innerHTML = html;
      return e;
    },

    $: function (sel, root) { return (root || document).querySelector(sel); },
    $$: function (sel, root) {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    },

    now: function () { return Date.now(); }
  };

  SE.U = U;
})(window);
