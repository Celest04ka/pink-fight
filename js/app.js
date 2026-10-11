// Start screen (a key press is needed anyway: browsers only allow sound after one). Drawn with Deltarune's own fonts.
// The encounter itself is Deltarune's code; this file only starts it.
'use strict';

(function () {
  const D = GM.draw;
  const $ = (id) => document.getElementById(id);
  const overlay = $('overlay'), status = $('status');
  const WHITE = 0xFFFFFF, GRAY = 0x808080; // BGR

  let A = null;
  const menu = { frame: 0, message: '' };

  function text(x, y, s, font, col, scale, alpha) {
    D.font = font; D.halign = 1; D.valign = 0;
    D.text(x, y, s, scale || 1, scale || 1, 0, [col, col, col, col], alpha == null ? 1 : alpha);
  }

  const STEP = 1000 / 30;
  let lastT = 0, accT = STEP;
  JF.menuFrame = function (now) {
    if (!A) return;
    accT += Math.min(250, Math.max(0, now - (lastT || now)));
    lastT = now;
    if (accT < STEP) return;
    while (accT >= STEP) { accT -= STEP; menu.frame++; }
    D.setBlend(0); D.setFog(false); D.setBlendEnable(true);
    D.begin(0);
    // Pink (assets/ui/pink.png, already 2x pixel art) in place of a title, centred
    if (A.title >= 0) { const s = GM.sprites[A.title]; D.sprite(A.title, 0, 320 - s.w, 60, 2, 2, 0, WHITE, 1); }
    text(320, 254, 'DELTARUNE  CHAPTER 5', A.small, GRAY);
    const blink = 0.55 + 0.45 * Math.sin(menu.frame / 10);
    text(320, 320, 'PRESS Z TO START', A.big, WHITE, 1, blink);
    if (menu.message) text(320, 380, menu.message, A.small, WHITE);
    godLabel();
    D.end();
  };

  // Alt+Q toggles God Mode (js/boot.js); while it is on, a small grey note sits in the top left corner
  function godLabel() {
    if (!JF.opts.invincible) return;
    D.font = A.small; D.halign = 0; D.valign = 0;
    D.text(6, 4, 'GOD MODE', 1, 1, 0, [GRAY, GRAY, GRAY, GRAY], 0.8);
  }
  D.hudDraw = function () {
    if (!A || !JF.opts.invincible) return;
    const saved = [D.font, D.halign, D.valign, D.color, D.alpha];
    godLabel();
    [D.font, D.halign, D.valign, D.color, D.alpha] = saved;
  };

  JF.keyFilter = (e) => {
    if (JF.running) return false;
    if ([13, 27, 88, 90].includes(e.keyCode)) e.preventDefault();
    GM.audio.resume();
    if (A && !e.repeat && (e.keyCode === 90 || e.keyCode === 13)) start();
    return true;
  };

  function start() {
    GM.audio.resume();
    menu.message = '';
    JF.start();
  }
  function back(message) {
    GM.audio.stopAll();
    menu.message = message || '';
  }
  JF.onError = (e) => back('Error: ' + (e && e.message ? e.message : e));
  JF.onFightOver = (result) => back(result === 'won' ? 'You made it to the end. Thanks for playing!' : '');
  JF.onQuit = () => back('');

  document.addEventListener('visibilitychange', () => {
    if (!GM.audio.ctx) return;
    if (document.hidden) GM.audio.ctx.suspend(); else GM.audio.ctx.resume();
  });

  // the start screen picture becomes an extra one-frame sprite on its own texture page
  function loadTitle() {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const p = D.pages.length;
        D.addPage(p, img);
        GM.sprites.push({ name: 'ui_pink_title', w: img.width, h: img.height, ox: 0, oy: 0, ml: 0, mr: img.width - 1, mt: 0, mb: img.height - 1, sep: 0, speed: 1, speedType: 1,
          frames: [{ p, sx: 0, sy: 0, sw: img.width, sh: img.height, tx: 0, ty: 0, tw: img.width, th: img.height, bw: img.width, bh: img.height }] });
        res(GM.sprites.length - 1);
      };
      img.onerror = () => res(-1);
      img.src = 'assets/ui/pink.png';
    });
  }

  JF.init($('screen'), (t) => { status.textContent = 'Loading: ' + t; })
    .then(loadTitle)
    .then((title) => {
      const id = (n) => GM.assetIndex.get(n).i;
      A = { big: id('fnt_mainbig'), small: id('fnt_main'), title };
      overlay.hidden = true;
    })
    .catch((e) => { status.textContent = 'Could not load: ' + e.message; console.error(e); });
})();
