// Boot: load extracted Deltarune ch5 data, build the translated GML, start the game at the Pink encounter.
'use strict';

(function () {
  const JF = window.JF = {
    paths: { meta: '_extract/meta/', assets: 'assets/' },
    running: false, paused: false, error: null,
    opts: {}
  };
  const D = GM.draw;
  // music streams the encounter asks for (snd_init): scr_battle prepares rakuichi_buster_wip.ogg (chapter 5 battle theme),
  // obj_pink_enemy swaps it for pink.ogg
  JF.MUSIC = ['pink.ogg', 'rakuichi_buster_wip.ogg', 'mus_confession.ogg', 'pink_theme.ogg', 'pink_theme_mad.ogg', 'noelle_normal.ogg',
    'AUDIO_DEFEAT.ogg', 'AUDIO_DRONE.ogg', 'AUDIO_DARKNESS.ogg'];
  // sound effects the opening scene and the start of the battle play (recorded in a run)
  JF.PRELOAD_SOUNDS = ['snd_impact', 'snd_rumble', 'snd_text', 'snd_weaponpull_fast', 'snd_whack_absurdlyloud'];

  // ------------------------------------------------------------ asset access
  // three sources: website pack (data/game.json + data/audio.bin + data/tex/*.png, see tools/build_site.js),
  // file:// bundles (window.JF_BUNDLE, tools/build_bundle.js), or the raw extraction (_extract/, dev only)
  let PACK = null;
  function urlFor(kind, name) {
    if (kind === 'meta') return JF.paths.meta + name;
    if (kind === 'tex') return JF.paths.meta + 'tex/' + name;
    if (kind === 'snd') return JF.paths.meta + 'snd/' + name;
    return JF.paths.assets + name;
  }
  async function fetchOk(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('fetch ' + url + ' ' + r.status);
    return r;
  }
  async function getJSON(kind, name) {
    const key = kind + '/' + name;
    if (PACK && PACK.json[key] !== undefined) return PACK.json[key];
    if (window.JF_BUNDLE && JF_BUNDLE.json[key]) return JF_BUNDLE.json[key];
    return (await fetchOk(urlFor(kind, name))).json();
  }
  async function getText(kind, name) {
    const key = kind + '/' + name;
    if (PACK && PACK.json[key] !== undefined) return PACK.json[key];
    if (window.JF_BUNDLE && JF_BUNDLE.text[key]) return JF_BUNDLE.text[key];
    return (await fetchOk(urlFor(kind, name))).text();
  }
  function b64ToBuf(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
  async function getBinary(kind, name) {
    const key = kind + '/' + name;
    if (PACK && PACK.audioIndex[key]) { const [off, len] = PACK.audioIndex[key]; return PACK.audio.slice(off, off + len); }
    if (window.JF_BUNDLE && JF_BUNDLE.bin[key]) return b64ToBuf(JF_BUNDLE.bin[key]);
    return (await fetchOk(urlFor(kind, name))).arrayBuffer();
  }
  function getImage(name) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('image ' + name));
      if (PACK) img.src = 'data/tex/' + name;
      else if (window.JF_BUNDLE && JF_BUNDLE.bin['tex/' + name]) img.src = 'data:image/png;base64,' + JF_BUNDLE.bin['tex/' + name];
      else img.src = urlFor('tex', name);
    });
  }
  // texture page for the website pack: fetched as a blob (with retries) and decoded to an ImageBitmap,
  // which is closed right after the GPU upload to keep memory low on phones
  function blobToImage(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('the browser could not decode the image')); };
      img.src = url;
    });
  }
  async function loadPackTexture(name) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch('data/tex/' + name, { cache: attempt ? 'reload' : 'default' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        if (window.createImageBitmap) {
          try { return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (e) { /* fall back to <img> */ }
        }
        return await blobToImage(blob);
      } catch (e) { last = e; }
    }
    throw new Error('texture ' + name + ' (' + (last && last.message ? last.message : last) + ')');
  }

  async function tryLoadPack(progress) {
    let r;
    try { r = await fetch('data/game.json'); } catch (e) { return false; }
    if (!r.ok) return false;
    progress && progress('data');
    const json = await r.json();
    progress && progress('audio');
    const audio = await (await fetchOk('data/audio.bin')).arrayBuffer();
    PACK = { json, audio, audioIndex: json.__audio };
    return true;
  }
  // GM file names used by audio streams ("mus/joker.ogg") and sounds ("ext:snd_x.ogg")
  GM.audio.loader = async function (file) {
    file = String(file).replace(/\\/g, '/');
    if (file.startsWith('snd:')) return getBinary('snd', file.slice(4));
    if (file.startsWith('ext:')) return getBinary('assets', 'ext/' + file.slice(4));
    return getBinary('assets', file.replace(/^.*?mus\//, 'mus/'));
  };

  // ------------------------------------------------------------ loading
  JF.load = async function (progress) {
    const say = (t) => progress && progress(t);
    say('data');
    const [sprites, objects, fonts, sounds, backgrounds, roomsList, rooms, general, scripts] = await Promise.all(
      ['sprites', 'objects', 'fonts', 'sounds', 'backgrounds', 'rooms_list', 'rooms', 'general', 'scripts'].map(n => getJSON('meta', n + '.json')));
    // asset index exactly like the translator (tools/gml2js.js buildAssets)
    const ai = GM.assetIndex;
    const add = (list, kind) => list.forEach((x, i) => { const nm = typeof x === 'string' ? x : x && x.name; if (nm) ai.set(nm, { kind, i }); });
    add(sprites, 'sprite'); add(sounds, 'sound'); add(backgrounds, 'background'); add(fonts, 'font'); add(roomsList, 'room'); add(objects, 'object');
    scripts.forEach((s, i) => { if (s && s.name && !ai.has(s.name)) ai.set(s.name, { kind: 'script', i }); });
    GM.scripts = scripts;
    GM.scriptByIndex = (i) => scripts[i] && GM.S[scripts[i].name];
    // sprites + collision masks
    GM.sprites = sprites.map(s => {
      if (!s) return null;
      const sp = Object.assign({}, s);
      sp.frames = s.frames.filter(Boolean);
      if (s.masks && s.masks.length && s.masks[0]) {
        sp.maskData = s.masks.map(m => m ? new Uint8Array(b64ToBuf(m)) : null);
        sp.mstride = (s.mw + 7) >> 3;
        // masks are either full-size or cropped to the bbox
        if (s.mw === s.w && s.mh === s.h) { sp.maskOx = 0; sp.maskOy = 0; } else { sp.maskOx = s.ml; sp.maskOy = s.mt; }
      }
      delete sp.masks;
      return sp;
    });
    // nine-slice sprites (GMS 2.3; tools/read_nineslice.js): borders keep their size when the sprite is scaled
    const nine = await getJSON('meta', 'nineslice.json').catch(() => ({}));
    for (const sp of GM.sprites) if (sp && nine[sp.name]) sp.nine = nine[sp.name];
    GM.backgrounds = backgrounds;
    GM.roomNames = roomsList;
    GM.rooms = rooms;
    GM.roomOrder = general.roomOrder.map(n => ai.get(n) ? ai.get(n).i : -1).filter(i => i >= 0);
    GM.general = general;
    GM.sounds = sounds.map(s => s ? { name: s.name, file: s.file, volume: s.volume === undefined ? 1 : s.volume, pitch: s.pitch || 1, group: s.group, buffer: null } : null);
    D.setupFonts(fonts);
    // textures
    say('textures');
    const pages = Math.max(...sprites.filter(Boolean).flatMap(s => s.frames.filter(Boolean).map(f => f.p)), ...fonts.filter(Boolean).map(f => f.tex ? f.tex.p : 0)) + 1;
    for (let i = 0; i < pages; i++) {
      say(`textures ${i + 1}/${pages}`);
      const img = PACK ? await loadPackTexture(i + '.png') : await getImage(i + '.png');
      D.addPage(i, img);
      if (img.close) img.close();
    }
    // language file into the virtual file system
    GM.vfs.set('lang/lang_en.json', await getText('assets', 'lang/lang_en.json'));
    // sounds
    say('sounds');
    GM.audio.init();
    const entries = [];
    GM.sounds.forEach((s, i) => {
      if (!s || !s.file) return;
      entries.push({ index: i, url: s.file.startsWith('ext:') ? s.file : 'snd:' + s.file });
    });
    // dev: ?nosound skips decoding the sound effects and music (faster reloads while testing)
    if (!/[?&]nosound/.test(location.search)) {
      // chapter 5 has ~500 sounds; only the ones this scene plays are decoded up front, the rest on first use
      const pre = new Set(JF.PRELOAD_SOUNDS);
      GM.audio.lazySounds = true;
      await GM.audio.loadSounds(entries.filter(e => GM.sounds[e.index] && pre.has(GM.sounds[e.index].name)), (d, n) => say(`sounds ${d}/${n}`));
      // only the fight music is preloaded; the game-over songs load on first use (audio_create_stream), saving memory on phones
      await Promise.all(JF.MUSIC.slice(0, 1).map(f => GM.audio.preloadStream('mus/' + f).catch(e => console.warn(e))));
    }
    // translated GML
    say('code');
    JF.objectsMeta = objects;
    buildGML();
    say('ready');
  };

  function buildGML() {
    GM.S = {}; GM.C = {}; GM.I = {};
    const rt = Object.assign({}, GM.rt, { G: GM.globals, R: GM.R, F: GM.F, S: GM.S, C: GM.C, I: GM.I });
    GML_BUILD(rt);
    nativeOverrides();
    // test switch (no menu entry): JF.opts.invincible skips the damage scripts
    for (const n of ['scr_damage', 'scr_damage_all', 'scr_damage_maxhp', 'scr_damage_fixed']) {
      const f = GM.S[n];
      if (f) GM.S[n] = function (self, other, ...a) { if (JF.opts.invincible) return 0; return f(self, other, ...a); };
    }
    GM.setupObjects(JF.objectsMeta, GM.C);
  }

  JF.inBattle = () => JF.running && GM.instanceExists(GM.assetIndex.get('obj_battlecontroller').i);

  // faster native versions of a few compatibility scripts (same behaviour)
  function nativeOverrides() {
    const S = GM.S, F = GM.F;
    const viewProp = (prop, idx) => {
      const v = GM.views[idx] || GM.views[0];
      switch (prop) {
        case 0: return v.cam.x; case 1: return v.cam.y; case 2: return v.cam.w; case 3: return v.cam.h; case 4: return v.cam.angle;
        case 5: return v.cam.bx; case 6: return v.cam.by; case 7: return v.cam.sx; case 8: return v.cam.sy; case 9: return v.cam.target;
        case 10: return +v.visible; case 11: return v.px; case 12: return v.py; case 13: return v.pw; case 14: return v.ph; case 15: return idx; case 16: return -1;
      }
      return -1;
    };
    S.__view_get = (self, other, prop, idx) => viewProp(prop, idx);
    S.scr_tempload = () => { JF.pending = 'retry'; };
    S.ossafe_game_end = () => { JF.pending = 'menu'; };
    const origSet = S.__view_set;
    S.__view_set = (self, other, prop, idx, val) => {
      const v = GM.views[idx] || GM.views[0];
      switch (prop) {
        case 0: v.cam.x = val; return; case 1: v.cam.y = val; return; case 2: v.cam.w = val; return; case 3: v.cam.h = val; return;
        case 9: v.cam.target = val; return; case 10: v.visible = RT_t(val); return;
      }
      if (origSet) origSet(self, other, prop, idx, val);
    };
  }
  const RT_t = (v) => GM.rt.$t(v);

  // ------------------------------------------------------------ game state for the encounter (chapter 5, Pink retry)
  // chapter 5 gear (ids from scr_weaponinfo / scr_armorinfo): AquaKnife / Thatchet / BlueShoes;
  // Kris TrueTie + NetskieHat, Susie O.Glove + GreenApron, Ralsei SethSpecs + RedRibbon
  JF.PINK_GEAR = { weapon: [0, 33, 31, 32], armor1: [0, 31, 37, 35], armor2: [0, 34, 38, 33] };
  // food: ReviveMint x2, PunchBowl, GreenTea x2, Flavigne, Scarlixir, Rhapsotea, TreeCake, OrangeJuice, Phanta, TensionBit
  JF.PINK_ITEMS = [2, 2, 40, 42, 42, 41, 62, 61, 65, 43, 68, 27];
  function applyPinkSave(self) {
    const G = GM.globals, S = GM.S;
    G.darkzone = 1;
    G.interact = 0;
    // obj_dw_pink_encounter: flag[1846] < 2 = the encounter has not happened yet;
    // tempflag[62] >= 1 = Pink was fought before, so the room plays the short scene (con 0.1 -> 1.1) instead of the dialogue
    G.flag[1846] = 0;
    G.tempflag[62] = 1;
    S.scr_losechar(self, self);
    G.char[0] = 1;
    if (!S.scr_havechar(self, self, 2)) S.scr_getchar(self, self, 2);
    if (!S.scr_havechar(self, self, 3)) S.scr_getchar(self, self, 3);
    G.charauto[0] = 0; G.charauto[1] = 0; G.charauto[2] = 0; G.charauto[3] = 0;
    G.truename = 'KRIS';
    const gear = JF.PINK_GEAR;
    for (let i = 1; i <= 3; i++) { G.charweapon[i] = gear.weapon[i]; G.chararmor1[i] = gear.armor1[i]; G.chararmor2[i] = gear.armor2[i]; }
    S.scr_weaponinfo_mine(self, self);
    S.scr_armorinfo_mine(self, self);
    for (let i = 0; i < 13; i++) G.item[i] = JF.PINK_ITEMS[i] || 0;
    S.scr_iteminfo_all(self, self);
    for (let i = 0; i < 4; i++) G.hp[i] = G.maxhp[i];
    G.flag[16] = 1; // music volume
    G.facing = 1;
    G.entrance = 0;
    JF.saveApplied = true;
  }

  // ------------------------------------------------------------ start / restart
  JF.start = function () {
    JF.error = null;
    GM.audio.stopAll();
    // fresh runtime state
    for (const k of Object.keys(GM.globals)) delete GM.globals[k];
    GM.instances.length = 0; GM.byId.clear(); GM.lastId = 300000; GM.room = -1; GM.newRoom = -1; GM.started = false;
    GM.dsMaps.length = 0; GM.dsLists.length = 0;
    D.fontsRt.length = 0; D.setupFonts(JF.fontsMeta || []);
    D.font = -1; D.color = 0xFFFFFF; D.alpha = 1; D.halign = 0; D.valign = 0;
    GM.input.clear();
    GM.globalSelf = new GM.Instance(-5, { index: -1, sprite: -1, mask: -1, depth: 0, visible: false, solid: false, persistent: false, ev: new Map(), col: [], ancSet: new Set(), descSet: new Set() });
    // global script top-level code (GMS 2.3 runs it before the first room)
    for (const name of GM.general.globalInit) { const f = GM.I[name]; if (f) f(GM.globalSelf, GM.globalSelf); }
    // the first room change out of ROOM_INITIALIZE goes to the Pink encounter instead of the title screens
    JF.saveApplied = false;
    JF.result = null;
    const encounter = GM.assetIndex.get('room_dw_pink_encounter').i;
    GM.roomRedirect = function (target) {
      const name = GM.roomNames[target];
      if (!JF.saveApplied) { applyPinkSave(GM.globalSelf); return encounter; }
      // game over screens as in the game (CONTINUE calls scr_tempload = restart, GIVE UP calls ossafe_game_end = start screen)
      if (name === 'room_gameover' || name === 'PLACE_FAILURE') return target;
      // after the battle obj_dw_pink_encounter plays its ending scene and leaves for room_dw_fcastle_pinkroom: the run is over
      JF.result = name === 'room_dw_fcastle_pinkroom' ? 'won' : JF.result;
      JF.onFightOver && JF.onFightOver(JF.result);
      return -1;
    };
    GM.beforeStep = null;
    JF.battleLocked = false;
    GM.gotoRoomNow(GM.assetIndex.get('ROOM_INITIALIZE').i);
    JF.running = true;
  };

  // room_goto goes through the redirect hook
  const origGoto = GM.F.room_goto;
  GM.checkRoomOrig = GM.checkRoom;
  GM.checkRoom = function () {
    if (GM.newRoom !== -1 && GM.roomRedirect) {
      const r = GM.roomRedirect(GM.newRoom);
      if (r === -1) { GM.newRoom = -1; JF.running = false; return true; }
      GM.newRoom = r;
    }
    return GM.checkRoomOrig();
  };

  // ------------------------------------------------------------ main loop
  GM.onGameEnd = () => { JF.pending = 'menu'; };
  // one game step plus handling of requests made by the game code during it
  JF.tick = function () {
    GM.step();
    if (JF.pending) {
      const p = JF.pending;
      JF.pending = null;
      if (p === 'retry') { JF.retryQuick = true; JF.start(); }
      else if (p === 'menu') { JF.running = false; GM.audio.stopAll(); JF.onQuit && JF.onQuit(); }
    }
  };
  let acc = 0, last = 0;
  const STEP = 1000 / 30;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!last) last = now;
    acc += now - last;
    last = now;
    if (!JF.running || JF.paused) {
      acc = 0;
      if (!JF.running && JF.menuFrame) { try { JF.menuFrame(now); } catch (e) { console.error(e); JF.menuFrame = null; } }
      return;
    }
    let n = 0;
    while (acc >= STEP && n < 3) {
      try { JF.tick(); } catch (e) { JF.fail(e); return; }
      acc -= STEP; n++;
    }
    if (acc > STEP * 3) acc = 0;
  }
  JF.fail = function (e) {
    JF.running = false;
    JF.error = e;
    console.error('[PinkFight] runtime error', e);
    JF.onError && JF.onError(e);
  };
  JF.stepN = function (n) { for (let i = 0; i < n; i++) JF.tick(); };

  // ------------------------------------------------------------ input
  const blockKeys = new Set([37, 38, 39, 40, 32, 13, 16, 17, 9, 112, 113, 114, 116, 117, 118, 119, 120, 121, 122, 123]);
  // WASD works like the arrow keys (W up, A left, S down, D right)
  const WASD = { 87: 38, 65: 37, 83: 40, 68: 39 };
  window.addEventListener('keydown', (e) => {
    if (e.keyCode === 115 || (e.keyCode === 13 && e.altKey)) { // F4 / Alt+Enter: fullscreen
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => 0);
      return;
    }
    if (JF.keyFilter && JF.keyFilter(e)) return;
    if (blockKeys.has(e.keyCode) || (e.keyCode >= 65 && e.keyCode <= 90 && !e.ctrlKey)) e.preventDefault();
    GM.input.keyDown(WASD[e.keyCode] || e.keyCode);
    GM.audio.resume();
  });
  window.addEventListener('keyup', (e) => { GM.input.keyUp(WASD[e.keyCode] || e.keyCode); });
  window.addEventListener('blur', () => GM.input.clear());

  // opened by double click (file://): fetch() is not allowed, so load the packed resources as scripts
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('missing ' + src + ' (build it: node tools/build_bundle.js)'));
      document.head.appendChild(s);
    });
  }

  JF.init = async function (canvas, progress) {
    D.init(canvas);
    D.resize();
    window.addEventListener('resize', D.resize);
    if (location.protocol === 'file:' || /[?&]bundle/.test(location.search)) {
      progress && progress('resource packs');
      try {
        for (const n of ['meta', 'tex', 'snd']) await loadScript('data/bundle_' + n + '.js');
      } catch (e) {
        throw new Error('this copy has to be opened through a web server (for example the GitHub Pages site), not as a local file');
      }
    } else {
      await tryLoadPack(progress);
    }
    await JF.load(progress);
    JF.fontsMeta = await getJSON('meta', 'fonts.json');
    requestAnimationFrame(frame);
  };
})();
