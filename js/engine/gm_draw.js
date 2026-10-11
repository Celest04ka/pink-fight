// WebGL renderer emulating GameMaker drawing into an application surface (640x480 by default).
// Surfaces, extended blend modes, colour write masks, alpha test, primitives, tile/background layers.
'use strict';

(function () {
  const D = GM.draw = {
    W: 640, H: 480,
    color: 0xFFFFFF, alpha: 1, font: -1, halign: 0, valign: 0,
    fog: null, blendEnabled: true, blendMode: 0, circlePrecision: 24,
    pages: [], // texture pages (WebGL textures with .w/.h)
    fontsRt: [], // runtime font objects (index = font asset index, plus added sprite fonts)
    surfaces: [] // { fbo, tex, w, h }
  };
  const APP_SURFACE = -1000;
  D.APP_SURFACE = APP_SURFACE;

  const MAXV = 6 * 4096;
  const STRIDE = 20; // x,y,u,v float32 + rgba u8
  let gl, prog, vbuf, data, f32, u8, count = 0, curTex = null, whiteTex, appFbo, appTex, canvas, uRes, uFog, uFlipY, uAlphaRef;
  let target = null; // current render target { fbo, w, h }
  const targetStack = [];

  D.init = function (cnv) {
    canvas = cnv;
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available');
    D.gl = gl;
    const vs = `attribute vec2 aPos; attribute vec2 aUV; attribute vec4 aCol;
      uniform vec2 uRes; uniform float uFlipY; varying vec2 vUV; varying vec4 vCol;
      void main() { vec2 p = aPos / uRes * 2.0 - 1.0; gl_Position = vec4(p.x, -p.y * uFlipY, 0.0, 1.0); vUV = aUV; vCol = aCol; }`;
    const fs = `precision mediump float; uniform sampler2D uTex; uniform vec4 uFog; uniform float uAlphaRef; varying vec2 vUV; varying vec4 vCol;
      void main() { vec4 c = texture2D(uTex, vUV) * vCol; if (uFog.a > 0.5) c.rgb = uFog.rgb; if (c.a <= uAlphaRef) discard; gl_FragColor = c; }`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    uRes = gl.getUniformLocation(prog, 'uRes');
    uFog = gl.getUniformLocation(prog, 'uFog');
    uFlipY = gl.getUniformLocation(prog, 'uFlipY');
    uAlphaRef = gl.getUniformLocation(prog, 'uAlphaRef');
    gl.uniform4f(uFog, 0, 0, 0, 0);
    gl.uniform1f(uAlphaRef, -1);
    data = new ArrayBuffer(MAXV * STRIDE);
    f32 = new Float32Array(data);
    u8 = new Uint8Array(data);
    vbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos'), aUV = gl.getAttribLocation(prog, 'aUV'), aCol = gl.getAttribLocation(prog, 'aCol');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, STRIDE, 8);
    gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 4, gl.UNSIGNED_BYTE, true, STRIDE, 16);
    whiteTex = makeTex(1, 1, new Uint8Array([255, 255, 255, 255]));
    whiteTex.w = 1; whiteTex.h = 1;
    appTex = makeTex(D.W, D.H, null);
    appTex.w = D.W; appTex.h = D.H;
    appFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, appFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, appTex, 0);
    target = { fbo: appFbo, w: D.W, h: D.H, tex: appTex };
    gl.enable(gl.BLEND);
    setBlend(0);
  };

  function makeTex(w, h, pixels, img) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (img) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    curTex = t;
    return t;
  }

  D.addPage = function (i, img) {
    const t = makeTex(img.width, img.height, null, img);
    t.w = img.width; t.h = img.height;
    D.pages[i] = t;
  };

  function flush() {
    if (count === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(data, 0, count * STRIDE));
    gl.drawArrays(gl.TRIANGLES, 0, count);
    count = 0;
  }
  D.flush = flush;

  function useTex(t) {
    if (t !== curTex) { flush(); curTex = t; gl.bindTexture(gl.TEXTURE_2D, t); }
  }

  // ---------------------------------------------------------------- blend / gpu state
  // GameMaker applies the same factors to colour and alpha (bm_normal squares alpha on surfaces, like the real runner)
  const BMF = () => [null, gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
    gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA_SATURATE];
  function setBlend(mode) {
    flush();
    D.blendMode = mode;
    gl.blendEquation(gl.FUNC_ADD);
    switch (mode) {
      case 1: gl.blendFunc(gl.SRC_ALPHA, gl.ONE); break; // add
      case 2: gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_COLOR); break; // max
      case 3: gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_COLOR); break; // subtract
      case 4: gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); break; // reverse subtract
      default: gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); break;
    }
  }
  D.setBlend = setBlend;
  D.setBlendExt = function (src, dst, srcA, dstA) {
    flush();
    const m = BMF();
    D.blendMode = -1;
    gl.blendEquation(gl.FUNC_ADD);
    if (srcA === undefined) gl.blendFunc(m[src] || gl.ONE, m[dst] || gl.ZERO);
    else gl.blendFuncSeparate(m[src] || gl.ONE, m[dst] || gl.ZERO, m[srcA] || gl.ONE, m[dstA] || gl.ZERO);
  };
  D.setBlendEnable = function (on) { flush(); D.blendEnabled = on; if (on) gl.enable(gl.BLEND); else gl.disable(gl.BLEND); };
  D.setFog = function (on, col) {
    flush();
    if (on) gl.uniform4f(uFog, (col & 255) / 255, ((col >> 8) & 255) / 255, ((col >> 16) & 255) / 255, 1);
    else gl.uniform4f(uFog, 0, 0, 0, 0);
    D.fog = on ? col : null;
  };
  D.colorMask = [true, true, true, true];
  D.setColorWrite = function (r, g, b, a) { flush(); D.colorMask = [r, g, b, a]; gl.colorMask(r, g, b, a); };
  D.alphaTest = false; D.alphaRef = 0;
  function applyAlphaTest() { gl.uniform1f(uAlphaRef, D.alphaTest ? D.alphaRef / 255 : -1); }
  D.setAlphaTest = function (on) { flush(); D.alphaTest = on; applyAlphaTest(); };
  D.setAlphaRef = function (v) { flush(); D.alphaRef = v; applyAlphaTest(); };
  // reset GPU state between frames of the outer menu and the game
  D.resetState = function () {
    setBlend(0); D.setBlendEnable(true); D.setFog(false); D.setColorWrite(true, true, true, true); D.setAlphaTest(false);
  };

  // room-space -> target offset (camera), applied at vertex write time
  let offX = 0, offY = 0;
  D.setOffset = function (x, y) { flush(); offX = x; offY = y; D.offX = x; D.offY = y; };

  function vert(x, y, u, v, r, g, b, a) {
    if (count >= MAXV) flush();
    const o = count * 5;
    f32[o] = x + offX; f32[o + 1] = y + offY; f32[o + 2] = u; f32[o + 3] = v;
    const ob = count * STRIDE + 16;
    u8[ob] = r; u8[ob + 1] = g; u8[ob + 2] = b; u8[ob + 3] = a;
    count++;
  }
  const A8 = (alpha) => Math.max(0, Math.min(255, Math.round(alpha * 255)));

  // textured quad: 4 corners (x,y) and uv rect, per-corner colours [c0 tl, c1 tr, c2 br, c3 bl] as BGR ints
  function quad(tex, x0, y0, x1, y1, x2, y2, x3, y3, u0, v0, u1, v1, c0, c1, c2, c3, alpha) {
    if (count + 6 > MAXV) flush();
    useTex(tex);
    const a = A8(alpha);
    const R = c => c & 255, G = c => (c >> 8) & 255, B = c => (c >> 16) & 255;
    vert(x0, y0, u0, v0, R(c0), G(c0), B(c0), a);
    vert(x1, y1, u1, v0, R(c1), G(c1), B(c1), a);
    vert(x2, y2, u1, v1, R(c2), G(c2), B(c2), a);
    vert(x0, y0, u0, v0, R(c0), G(c0), B(c0), a);
    vert(x2, y2, u1, v1, R(c2), G(c2), B(c2), a);
    vert(x3, y3, u0, v1, R(c3), G(c3), B(c3), a);
  }

  function tri(x0, y0, x1, y1, x2, y2, c0, c1, c2, alpha) {
    if (count + 3 > MAXV) flush();
    useTex(whiteTex);
    const a = A8(alpha);
    vert(x0, y0, 0.5, 0.5, c0 & 255, (c0 >> 8) & 255, (c0 >> 16) & 255, a);
    vert(x1, y1, 0.5, 0.5, c1 & 255, (c1 >> 8) & 255, (c1 >> 16) & 255, a);
    vert(x2, y2, 0.5, 0.5, c2 & 255, (c2 >> 8) & 255, (c2 >> 16) & 255, a);
  }
  D.tri = tri;

  // ---------------------------------------------------------------- generic textured region
  // draw a texture region (uv rect) whose local unrotated/unscaled box is (lx,ly,lw,lh) relative to the anchor (x,y)
  function drawTex(tex, u0, v0, u1, v1, lx, ly, lw, lh, x, y, xs, ys, rot, cols, alpha) {
    const ax = lx * xs, ay = ly * ys, bx = (lx + lw) * xs, by = (ly + lh) * ys;
    let x0, y0, x1, y1, x2, y2, x3, y3;
    if (rot === 0) {
      x0 = x + ax; y0 = y + ay; x1 = x + bx; y1 = y + ay; x2 = x + bx; y2 = y + by; x3 = x + ax; y3 = y + by;
    } else {
      const c = Math.cos(rot * Math.PI / 180), s = Math.sin(rot * Math.PI / 180);
      const tx = (px, py) => x + px * c + py * s, ty = (px, py) => y - px * s + py * c;
      x0 = tx(ax, ay); y0 = ty(ax, ay); x1 = tx(bx, ay); y1 = ty(bx, ay); x2 = tx(bx, by); y2 = ty(bx, by); x3 = tx(ax, by); y3 = ty(ax, by);
    }
    quad(tex, x0, y0, x1, y1, x2, y2, x3, y3, u0, v0, u1, v1, cols[0], cols[1], cols[2], cols[3], alpha);
  }

  // ---------------------------------------------------------------- sprites
  function frameOf(s, sub) {
    const n = s.frames.length;
    if (n === 0) return null;
    let i = Math.floor(sub) % n;
    if (i < 0) i += n;
    return s.frames[i];
  }
  D.frameOf = frameOf;

  // the site build leaves out sprites the fight never draws (their frames get p = -1)
  function missingPage(fr) {
    if (fr.p < 0) GM.warnOnce('trimmed sprite drawn: ' + (fr.trimmed || '?'));
  }
  function drawRegion(fr, sx, sy, sw, sh, lx, ly, lw, lh, x, y, xs, ys, rot, col, alpha, cols) {
    const page = D.pages[fr.p];
    if (!page) { missingPage(fr); return; }
    drawTex(page, sx / page.w, sy / page.h, (sx + sw) / page.w, (sy + sh) / page.h, lx, ly, lw, lh, x, y, xs, ys, rot, cols || [col, col, col, col], alpha);
  }

  D.sprite = function (spr, sub, x, y, xs, ys, rot, col, alpha) {
    const s = GM.sprites[spr];
    if (!s) return;
    const fr = frameOf(s, sub);
    if (!fr) return;
    if (s.nine && (xs !== 1 || ys !== 1)) { drawNine(s, fr, x, y, xs, ys, rot, col, alpha); return; }
    drawRegion(fr, fr.sx, fr.sy, fr.sw, fr.sh, fr.tx - s.ox, fr.ty - s.oy, fr.tw, fr.th, x, y, xs, ys, rot, col, alpha);
  };

  // nine-slice: corners keep their size, edges and centre stretch (repeat/mirror tile modes are drawn stretched,
  // blank/hide are skipped). Slices are cut in sprite space and clipped to the frame's trimmed texture area.
  function drawNine(s, fr, x, y, xs, ys, rot, col, alpha) {
    const n = s.nine, W = s.w * Math.abs(xs), H = s.h * Math.abs(ys);
    let l = n.l, r = n.r, t = n.t, b = n.b;
    if (l + r > W) { const k = W / (l + r); l *= k; r *= k; }
    if (t + b > H) { const k = H / (t + b); t *= k; b *= k; }
    const sxs = [0, n.l, s.w - n.r, s.w], dxs = [0, l, W - r, W];
    const sys = [0, n.t, s.h - n.b, s.h], dys = [0, t, H - b, H];
    const ox = s.ox * Math.abs(xs), oy = s.oy * Math.abs(ys);
    const kx = fr.sw / fr.tw, ky = fr.sh / fr.th;
    for (let cy = 0; cy < 3; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        // tile modes: left, top, right, bottom, centre
        const mode = cx === 1 && cy === 1 ? n.modes[4] : cy === 1 ? n.modes[cx === 0 ? 0 : 2] : cx === 1 ? n.modes[cy === 0 ? 1 : 3] : 0;
        if (mode >= 3) continue;
        const a0 = sxs[cx], a1 = sxs[cx + 1], b0 = sys[cy], b1 = sys[cy + 1];
        if (a1 <= a0 || b1 <= b0) continue;
        const ix0 = Math.max(a0, fr.tx), ix1 = Math.min(a1, fr.tx + fr.tw), iy0 = Math.max(b0, fr.ty), iy1 = Math.min(b1, fr.ty + fr.th);
        if (ix1 <= ix0 || iy1 <= iy0) continue;
        const mx = (v) => dxs[cx] + (v - a0) * (dxs[cx + 1] - dxs[cx]) / (a1 - a0);
        const my = (v) => dys[cy] + (v - b0) * (dys[cy + 1] - dys[cy]) / (b1 - b0);
        drawRegion(fr, fr.sx + (ix0 - fr.tx) * kx, fr.sy + (iy0 - fr.ty) * ky, (ix1 - ix0) * kx, (iy1 - iy0) * ky,
          mx(ix0) - ox, my(iy0) - oy, mx(ix1) - mx(ix0), my(iy1) - my(iy0), x, y, xs < 0 ? -1 : 1, ys < 0 ? -1 : 1, rot, col, alpha);
      }
    }
  }

  D.spriteGeneral = function (spr, sub, left, top, w, h, x, y, xs, ys, rot, cols, alpha) {
    const s = GM.sprites[spr];
    if (!s) return;
    const fr = frameOf(s, sub);
    if (!fr) return;
    const ix0 = Math.max(left, fr.tx), iy0 = Math.max(top, fr.ty);
    const ix1 = Math.min(left + w, fr.tx + fr.tw), iy1 = Math.min(top + h, fr.ty + fr.th);
    if (ix1 <= ix0 || iy1 <= iy0) return;
    const kx = fr.sw / fr.tw, ky = fr.sh / fr.th;
    const sx = fr.sx + (ix0 - fr.tx) * kx, sy = fr.sy + (iy0 - fr.ty) * ky;
    drawRegion(fr, sx, sy, (ix1 - ix0) * kx, (iy1 - iy0) * ky, ix0 - left, iy0 - top, ix1 - ix0, iy1 - iy0, x, y, xs, ys, rot, 0xFFFFFF, alpha, cols);
  };

  D.spritePart = function (spr, sub, left, top, w, h, x, y, xs, ys, col, alpha) {
    D.spriteGeneral(spr, sub, left, top, w, h, x, y, xs, ys, 0, [col, col, col, col], alpha);
  };

  D.spriteStretched = function (spr, sub, x, y, w, h, col, alpha) {
    const s = GM.sprites[spr];
    if (!s) return;
    if (s.nine) { const fr = frameOf(s, sub); if (fr) drawNine(s, fr, x + s.ox * w / s.w, y + s.oy * h / s.h, w / s.w, h / s.h, 0, col, alpha); return; }
    D.spriteGeneral(spr, sub, 0, 0, s.w, s.h, x, y, w / s.w, h / s.h, 0, [col, col, col, col], alpha);
  };

  // draw_sprite_pos: four free corners
  D.spritePos = function (spr, sub, x1, y1, x2, y2, x3, y3, x4, y4, alpha) {
    const s = GM.sprites[spr];
    if (!s) return;
    const fr = frameOf(s, sub);
    if (!fr) return;
    const page = D.pages[fr.p];
    if (!page) { missingPage(fr); return; }
    quad(page, x1, y1, x2, y2, x3, y3, x4, y4, fr.sx / page.w, fr.sy / page.h, (fr.sx + fr.sw) / page.w, (fr.sy + fr.sh) / page.h, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, alpha);
  };

  D.viewRect = function () {
    if (target.fbo !== appFbo || targetStack.length) return { x: -offX, y: -offY, w: target.w, h: target.h };
    const v = GM.views && GM.views[0];
    return v && v.visible ? { x: v.cam.x, y: v.cam.y, w: v.cam.w, h: v.cam.h } : { x: 0, y: 0, w: D.W, h: D.H };
  };

  D.spriteTiled = function (spr, sub, x, y, xs, ys, col, alpha, htile, vtile) {
    const s = GM.sprites[spr];
    if (!s) return;
    const w = s.w * xs, h = s.h * ys;
    if (w <= 0 || h <= 0) return;
    const cam = D.viewRect();
    let sx = x - s.ox * xs, sy = y - s.oy * ys;
    if (htile !== false) sx = cam.x + ((((sx - cam.x) % w) + w) % w) - w;
    if (vtile !== false) sy = cam.y + ((((sy - cam.y) % h) + h) % h) - h;
    const ex = htile === false ? sx + 1 : cam.x + cam.w, ey = vtile === false ? sy + 1 : cam.y + cam.h;
    for (let yy = sy; yy < ey; yy += h) for (let xx = sx; xx < ex; xx += w) D.sprite(spr, sub, xx + s.ox * xs, yy + s.oy * ys, xs, ys, 0, col, alpha);
  };

  // ---------------------------------------------------------------- shapes
  D.rect = function (x1, y1, x2, y2, outline, c1, c2, c3, c4, alpha) {
    if (x1 > x2) { const q = x1; x1 = x2; x2 = q; }
    if (y1 > y2) { const q = y1; y1 = y2; y2 = q; }
    if (outline) {
      D.rect(x1, y1, x2, y1, false, c1, c2, c2, c1, alpha);
      D.rect(x1, y2, x2, y2, false, c4, c3, c3, c4, alpha);
      D.rect(x1, y1 + 1, x1, y2 - 1, false, c1, c1, c4, c4, alpha);
      D.rect(x2, y1 + 1, x2, y2 - 1, false, c2, c2, c3, c3, alpha);
      return;
    }
    quad(whiteTex, x1, y1, x2 + 1, y1, x2 + 1, y2 + 1, x1, y2 + 1, 0, 0, 1, 1, c1, c2, c3, c4, alpha);
  };

  D.line = function (x1, y1, x2, y2, w, c1, c2, alpha) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) { D.rect(Math.floor(x1), Math.floor(y1), Math.floor(x1), Math.floor(y1), false, c1, c1, c1, c1, alpha); return; }
    const nx = -dy / len * w / 2, ny = dx / len * w / 2;
    const ox = w <= 1 ? 0.5 : 0, oy = w <= 1 ? 0.5 : 0;
    const ex = w <= 1 ? dx / len * 0.5 : 0, ey = w <= 1 ? dy / len * 0.5 : 0;
    const ax = x1 + ox - ex, ay = y1 + oy - ey, bx = x2 + ox + ex, by = y2 + oy + ey;
    quad(whiteTex, ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny, 0, 0, 1, 1, c1, c2, c2, c1, alpha);
  };

  D.triangle = function (x1, y1, x2, y2, x3, y3, outline, c1, c2, c3, alpha) {
    if (outline) {
      D.line(x1, y1, x2, y2, 1, c1, c2, alpha);
      D.line(x2, y2, x3, y3, 1, c2, c3, alpha);
      D.line(x3, y3, x1, y1, 1, c3, c1, alpha);
      return;
    }
    tri(x1, y1, x2, y2, x3, y3, c1, c2, c3, alpha);
  };

  D.ellipse = function (x1, y1, x2, y2, outline, c1, c2, alpha) {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    const n = D.circlePrecision;
    let px = cx + rx, py = cy;
    for (let i = 1; i <= n; i++) {
      const a = i / n * Math.PI * 2;
      const nx = cx + Math.cos(a) * rx, ny = cy + Math.sin(a) * ry;
      if (outline) D.line(px, py, nx, ny, 1, c2, c2, alpha);
      else tri(cx, cy, px, py, nx, ny, c1, c2, c2, alpha);
      px = nx; py = ny;
    }
  };

  D.circle = function (x, y, r, outline, c1, c2, alpha) { D.ellipse(x - r, y - r, x + r, y + r, outline, c1, c2, alpha); };

  D.clear = function (col, alpha) {
    flush();
    gl.colorMask(true, true, true, true);
    gl.clearColor((col & 255) / 255, ((col >> 8) & 255) / 255, ((col >> 16) & 255) / 255, alpha);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.colorMask(...D.colorMask);
  };

  // ---------------------------------------------------------------- primitives (draw_primitive_begin / draw_vertex)
  let prim = null;
  D.primBegin = function (kind, tex) { prim = { kind, tex: tex || whiteTex, v: [] }; };
  D.primVertex = function (x, y, u, v, col, alpha) { if (prim) prim.v.push([x, y, u, v, col, alpha]); };
  D.primEnd = function () {
    if (!prim) return;
    const { kind, tex, v } = prim;
    prim = null;
    const emit = (a, b, c) => {
      if (count + 3 > MAXV) flush();
      useTex(tex);
      for (const p of [a, b, c]) vert(p[0], p[1], p[2], p[3], p[4] & 255, (p[4] >> 8) & 255, (p[4] >> 16) & 255, A8(p[5]));
    };
    const line = (a, b) => D.line(a[0], a[1], b[0], b[1], 1, a[4], b[4], a[5]);
    if (kind === 4) for (let i = 0; i + 2 < v.length; i += 3) emit(v[i], v[i + 1], v[i + 2]);
    else if (kind === 5) for (let i = 0; i + 2 < v.length; i++) emit(v[i], v[i + 1], v[i + 2]);
    else if (kind === 6) for (let i = 1; i + 1 < v.length; i++) emit(v[0], v[i], v[i + 1]);
    else if (kind === 2) for (let i = 0; i + 1 < v.length; i += 2) line(v[i], v[i + 1]);
    else if (kind === 3) for (let i = 0; i + 1 < v.length; i++) line(v[i], v[i + 1]);
    else if (kind === 1) for (const p of v) D.rect(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[0]), Math.floor(p[1]), false, p[4], p[4], p[4], p[4], p[5]);
  };
  // texture handles for sprite_get_texture: a page texture plus the frame's uv rect
  D.texHandles = [];
  D.spriteTexture = function (spr, sub) {
    const s = GM.sprites[spr];
    const fr = s && frameOf(s, sub);
    if (!fr) return -1;
    const page = D.pages[fr.p];
    if (!page) { missingPage(fr); return -1; }
    D.texHandles.push({ tex: page, uvs: [fr.sx / page.w, fr.sy / page.h, (fr.sx + fr.sw) / page.w, (fr.sy + fr.sh) / page.h], w: page.w, h: page.h });
    return D.texHandles.length - 1;
  };
  D.texOf = function (h) {
    if (h === APP_SURFACE) return appTex;
    if (h <= -2000) { const s = D.surfaces[-2000 - h]; return s ? s.tex : whiteTex; }
    const t = D.texHandles[h];
    return t ? t.tex : whiteTex;
  };

  // ---------------------------------------------------------------- surfaces
  D.surfaceCreate = function (w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const tex = makeTex(w, h, null);
    tex.w = w; tex.h = h;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    // ids are never reused: code creates and frees surfaces up front to get distinct "dead" ids
    // (obj_purplecontrols), so a reused id would make two variables point to one surface
    const id = D.surfaces.length;
    D.surfaces[id] = { fbo, tex, w, h };
    return id;
  };
  function surf(id) {
    if (id === APP_SURFACE) return { fbo: appFbo, tex: appTex, w: D.W, h: D.H, app: true };
    return D.surfaces[id] || null;
  }
  D.surf = surf;
  D.surfaceExists = (id) => id === APP_SURFACE || (id >= 0 && !!D.surfaces[id]);
  D.surfaceFree = function (id) {
    const s = D.surfaces[id];
    if (!s) return;
    flush();
    if (target && target.fbo === s.fbo) D.surfaceReset();
    gl.deleteFramebuffer(s.fbo); gl.deleteTexture(s.tex);
    if (curTex === s.tex) curTex = null;
    D.surfaces[id] = null;
  };
  D.surfaceResize = function (id, w, h) {
    const s = D.surfaces[id];
    if (!s) return;
    flush();
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    s.w = s.tex.w = w; s.h = s.tex.h = h;
    curTex = s.tex;
  };
  function bindTarget(t, ox, oy) {
    flush();
    target = t;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    // a view smaller than its port (PLACE_FAILURE: 320x240 -> 640x480) is scaled up while the room is drawn
    const vr = t.fbo === appFbo && D.viewRes;
    gl.uniform2f(uRes, vr ? vr.w : t.w, vr ? vr.h : t.h);
    offX = ox; offY = oy; D.offX = ox; D.offY = oy;
  }
  D.surfaceSetTarget = function (id) {
    const s = surf(id);
    if (!s) { GM.warnOnce('surface_set_target missing surface'); return 0; }
    targetStack.push({ t: target, ox: offX, oy: offY });
    bindTarget(s, 0, 0);
    return 1;
  };
  D.surfaceReset = function () {
    const prev = targetStack.pop();
    if (!prev) return 0;
    bindTarget(prev.t, prev.ox, prev.oy);
    return 1;
  };
  D.currentTarget = function () {
    if (!targetStack.length) return APP_SURFACE;
    const i = D.surfaces.findIndex(s => s && s.fbo === target.fbo);
    return i >= 0 ? i : APP_SURFACE;
  };
  // draw a part of a surface; surface textures are stored bottom-up (rendered with a flipped projection)
  D.surface = function (id, sx, sy, sw, sh, x, y, xs, ys, rot, cols, alpha) {
    const s = surf(id);
    if (!s) return;
    if (s.fbo === target.fbo) { GM.warnOnce('draw surface onto itself'); return; }
    if (sx === undefined || sw === undefined) { sx = 0; sy = 0; sw = s.w; sh = s.h; } // whole surface (draw_surface / _ext)
    const u0 = sx / s.w, u1 = (sx + sw) / s.w, v0 = 1 - sy / s.h, v1 = 1 - (sy + sh) / s.h;
    drawTex(s.tex, u0, v0, u1, v1, 0, 0, sw, sh, x, y, xs, ys, rot, cols, alpha);
  };
  D.surfaceCopy = function (dest, x, y, src, sx, sy, sw, sh) {
    const d = surf(dest), s = surf(src);
    if (!d || !s) return;
    if (sw === undefined) { sx = 0; sy = 0; sw = s.w; sh = s.h; }
    targetStack.push({ t: target, ox: offX, oy: offY });
    bindTarget(d, 0, 0);
    const wasBlend = D.blendEnabled;
    gl.disable(gl.BLEND);
    drawTex(s.tex, sx / s.w, 1 - sy / s.h, (sx + sw) / s.w, 1 - (sy + sh) / s.h, 0, 0, sw, sh, x, y, 1, 1, 0, [0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF], 1);
    flush();
    if (wasBlend) gl.enable(gl.BLEND);
    D.surfaceReset();
  };
  D.surfaceGetPixel = function (id, x, y, withAlpha) {
    const s = surf(id);
    if (!s) return 0;
    flush();
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(x), s.h - 1 - Math.floor(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    const c = px[0] | (px[1] << 8) | (px[2] << 16);
    return withAlpha ? (c | (px[3] << 24)) >>> 0 : c;
  };

  // ---------------------------------------------------------------- fonts & text
  D.setupFonts = function (fontsMeta) {
    D.fontsRt = fontsMeta.map((f) => {
      if (!f) return null;
      const glyphs = new Map();
      let maxH = 0;
      for (const g of f.glyphs) { glyphs.set(g[0], { x: g[1], y: g[2], w: g[3], h: g[4], shift: g[5], offset: g[6] }); if (g[4] > maxH) maxH = g[4]; }
      return { name: f.name, tex: f.tex, glyphs, lineH: maxH, size: f.size, sprite: -1 };
    });
  };

  D.addSpriteFont = function (spr, map, prop, sep) {
    const s = GM.sprites[spr];
    const glyphs = new Map();
    let maxH = 0;
    [...map].forEach((ch, i) => {
      const fr = s.frames[i];
      if (!fr) return;
      const w = prop ? fr.tw : s.w;
      const off = prop ? -fr.tx : 0;
      glyphs.set(ch.codePointAt(0), { frame: i, shift: w + sep, offset: off, h: s.h });
      maxH = Math.max(maxH, s.h);
    });
    const f = { name: 'spritefont', sprite: spr, glyphs, lineH: maxH, prop };
    D.fontsRt.push(f);
    return D.fontsRt.length - 1;
  };

  function curFont() { return D.fontsRt[D.font] || D.fontsRt.find(f => f) || null; }
  D.curFont = curFont;
  function glyphOf(f, code) { return f.glyphs.get(code) || f.glyphs.get(32) || null; }
  function lineWidth(f, line) {
    let w = 0;
    for (const ch of line) { const g = glyphOf(f, ch.codePointAt(0)); if (g) w += g.shift; }
    return w;
  }
  function splitLines(str) { return String(str).split(/\r\n|\n|\r/); }

  D.stringWidth = function (str) {
    const f = curFont();
    if (!f) return 0;
    let m = 0;
    for (const l of splitLines(str)) m = Math.max(m, lineWidth(f, l));
    return m;
  };
  D.stringHeight = function (str) {
    const f = curFont();
    if (!f) return 0;
    return splitLines(str).length * f.lineH;
  };

  // generic text: cols = [tl, tr, br, bl] gradient across each line
  D.text = function (x, y, str, xs, ys, angle, cols, alpha, sep, maxw) {
    const f = curFont();
    if (!f) return;
    let lines = splitLines(str);
    const lh = sep !== undefined && sep >= 0 ? sep : f.lineH;
    if (maxw !== undefined && maxw > 0) lines = wrapLines(f, lines, maxw);
    const totalH = lines.length * lh;
    let oy = 0;
    if (D.valign === 1) oy = -totalH / 2; else if (D.valign === 2) oy = -totalH;
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
    const dc = cols || [D.color, D.color, D.color, D.color];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lw = lineWidth(f, line);
      let ox = 0;
      if (D.halign === 1) ox = -Math.floor(lw / 2); else if (D.halign === 2) ox = -lw;
      let cx = ox;
      const cy = oy + li * lh;
      for (const ch of line) {
        const g = glyphOf(f, ch.codePointAt(0));
        if (!g) continue;
        const gx = cx + g.offset;
        let gc = dc;
        if (cols) {
          const t0 = lw > 0 ? (gx - ox) / lw : 0, t1 = lw > 0 ? (gx - ox + (g.w || g.shift)) / lw : 1;
          gc = [mergeCol(cols[0], cols[1], t0), mergeCol(cols[0], cols[1], t1), mergeCol(cols[3], cols[2], t1), mergeCol(cols[3], cols[2], t0)];
        }
        const px = x + (gx * xs) * c + (cy * ys) * s, py = y - (gx * xs) * s + (cy * ys) * c;
        if (f.sprite >= 0) {
          const spr = GM.sprites[f.sprite];
          const fr = spr.frames[g.frame];
          if (fr) drawRegion(fr, fr.sx, fr.sy, fr.sw, fr.sh, fr.tx, fr.ty, fr.tw, fr.th, px, py, xs, ys, angle, 0xFFFFFF, alpha, gc);
        } else if (g.w > 0 && g.h > 0) {
          const t = f.tex;
          drawRegion({ p: t.p }, t.sx + g.x, t.sy + g.y, g.w, g.h, 0, 0, g.w, g.h, px, py, xs, ys, angle, 0xFFFFFF, alpha, gc);
        }
        cx += g.shift;
      }
    }
  };

  function wrapLines(f, lines, maxw) {
    const out = [];
    for (const line of lines) {
      const words = line.split(' ');
      let cur = '';
      for (const w of words) {
        const t = cur ? cur + ' ' + w : w;
        if (cur && lineWidth(f, t) > maxw) { out.push(cur); cur = w; } else cur = t;
      }
      out.push(cur);
    }
    return out;
  }

  function mergeCol(c1, c2, a) {
    const r = (c1 & 255) + ((c2 & 255) - (c1 & 255)) * a;
    const g = ((c1 >> 8) & 255) + (((c2 >> 8) & 255) - ((c1 >> 8) & 255)) * a;
    const b = ((c1 >> 16) & 255) + (((c2 >> 16) & 255) - ((c1 >> 16) & 255)) * a;
    return (r | 0) | ((g | 0) << 8) | ((b | 0) << 16);
  }
  D.mergeCol = mergeCol;

  // ---------------------------------------------------------------- room layers (tiles, backgrounds, assets)
  function tilesetOf(name) {
    const a = GM.assetIndex.get(name);
    return a ? GM.backgrounds[a.i] : null;
  }
  D.drawTileLayer = function (l) {
    const d = l.data;
    if (!d || !d.tiles || !d.bg) return;
    const ts = tilesetOf(d.bg);
    if (!ts || !ts.tex) return;
    const page = D.pages[ts.tex.p];
    if (!page) return;
    const tw = ts.tw, th = ts.th, bx = ts.bx, by = ts.by, cols = Math.max(1, ts.cols);
    const cam = D.viewRect();
    const x0 = Math.max(0, Math.floor((cam.x - l.x) / tw) - 1), x1 = Math.min(d.w - 1, Math.floor((cam.x + cam.w - l.x) / tw) + 1);
    const y0 = Math.max(0, Math.floor((cam.y - l.y) / th) - 1), y1 = Math.min(d.h - 1, Math.floor((cam.y + cam.h - l.y) / th) + 1);
    const alpha = l.tileAlpha === undefined ? 1 : l.tileAlpha;
    const W = [0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF];
    for (let ty = y0; ty <= y1; ty++) {
      const row = d.tiles[ty];
      if (!row) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const t = row[tx];
        const idx = t & 0x7FFFF;
        if (!idx) continue;
        const sx = ts.tex.sx + (idx % cols) * (tw + 2 * bx) + bx, sy = ts.tex.sy + Math.floor(idx / cols) * (th + 2 * by) + by;
        const mirror = (t >>> 28) & 1, flip = (t >>> 29) & 1, rotate = (t >>> 30) & 1;
        let u0 = sx / page.w, v0 = sy / page.h, u1 = (sx + tw) / page.w, v1 = (sy + th) / page.h;
        if (mirror) { const q = u0; u0 = u1; u1 = q; }
        if (flip) { const q = v0; v0 = v1; v1 = q; }
        const px = l.x + tx * tw, py = l.y + ty * th;
        if (!rotate) drawTex(page, u0, v0, u1, v1, 0, 0, tw, th, px, py, 1, 1, 0, W, alpha);
        else drawTex(page, u0, v0, u1, v1, 0, -th, tw, th, px, py, 1, 1, -90, W, alpha);
      }
    }
  };
  D.drawBackgroundLayer = function (l) {
    const d = l.data;
    if (!d || d.visible === false) return;
    const col = d.color & 0xFFFFFF, alpha = ((d.color >>> 24) & 255) / 255;
    if (d.sprite == null) {
      const cam = D.viewRect();
      if (alpha > 0) D.rect(cam.x, cam.y, cam.x + cam.w, cam.y + cam.h, false, col, col, col, col, alpha);
      return;
    }
    const si = GM.assetIndex.get(d.sprite);
    if (!si) return;
    const s = GM.sprites[si.i];
    const frame = l.frame || d.firstFrame || 0;
    if (d.stretch) D.spriteStretched(si.i, frame, l.x, l.y, GM.R.room_width, GM.R.room_height, col, alpha);
    else if (d.htiled || d.vtiled) D.spriteTiled(si.i, frame, l.x + s.ox, l.y + s.oy, l.xscale || 1, l.yscale || 1, col, alpha, !!d.htiled, !!d.vtiled);
    else D.sprite(si.i, frame, l.x + s.ox, l.y + s.oy, l.xscale || 1, l.yscale || 1, 0, col, alpha);
  };
  D.drawAssetLayer = function (l) {
    const d = l.data;
    if (!d) return;
    for (const t of d.tiles || []) {
      const ts = t.bg ? tilesetOf(t.bg) : null;
      if (ts && ts.tex) {
        const page = D.pages[ts.tex.p];
        const sx = ts.tex.sx + t.sx, sy = ts.tex.sy + t.sy;
        const c = (t.color === undefined ? 0xFFFFFFFF : t.color);
        const col = c & 0xFFFFFF, alpha = ((c >>> 24) & 255) / 255 || 1;
        drawTex(page, sx / page.w, sy / page.h, (sx + t.w) / page.w, (sy + t.h) / page.h, 0, 0, t.w, t.h, l.x + t.x, l.y + t.y, t.scaleX || 1, t.scaleY || 1, 0, [col, col, col, col], alpha);
      } else if (t.spr) {
        const si = GM.assetIndex.get(t.spr);
        if (si) D.spritePart(si.i, 0, t.sx, t.sy, t.w, t.h, l.x + t.x, l.y + t.y, t.scaleX || 1, t.scaleY || 1, 0xFFFFFF, 1);
      }
    }
    for (const s of d.sprites || []) {
      if (s.$destroyed) continue;
      const si = GM.assetIndex.get(s.spr);
      if (!si) continue;
      const c = s.color === undefined ? 0xFFFFFFFF : s.color;
      D.sprite(si.i, s.$frame !== undefined ? s.$frame : s.frame, l.x + s.x, l.y + s.y, s.scaleX, s.scaleY, s.rotation || 0, c & 0xFFFFFF, ((c >>> 24) & 255) / 255);
    }
  };
  D.drawLayer = function (l) {
    if (!l.visible) return;
    if (l.type === 4) D.drawTileLayer(l);
    else if (l.type === 1) D.drawBackgroundLayer(l);
    else if (l.type === 3) D.drawAssetLayer(l);
  };

  // ---------------------------------------------------------------- frame
  // begin/end a frame on the application surface (also used by the outer menu, which draws without the game)
  D.begin = function (bg) {
    targetStack.length = 0;
    bindTarget({ fbo: appFbo, w: D.W, h: D.H, tex: appTex }, 0, 0);
    gl.uniform1f(uFlipY, 1);
    D.clear(bg == null ? 0 : bg, 1);
  };
  D.end = function () { flush(); D.blit(); };

  D.frame = function () {
    D.begin(GM.bgColor);
    const v = GM.views && GM.views[0];
    D.camX = v && v.visible ? v.cam.x : 0;
    D.camY = v && v.visible ? v.cam.y : 0;
    D.setOffset(-D.camX, -D.camY);
    const scaled = v && v.visible && v.pw > 0 && v.ph > 0 && (v.cam.w !== v.pw || v.cam.h !== v.ph);
    D.viewRes = scaled ? { w: v.cam.w * D.W / v.pw, h: v.cam.h * D.H / v.ph } : null;
    if (scaled) bindTarget(target, offX, offY);
    const insts = GM.instances.filter(i => !i.$dead && i.$active && i.visible);
    // instances and room layers interleaved by depth (higher depth first; layers before instances at equal depth)
    const items = insts.map(i => ({ d: i.$depth, s: i.$seq, inst: i }));
    if (GM.layers) for (const l of GM.layers) if (l.type !== 2 && l.visible) items.push({ d: l.depth, s: -1e9 + (l.order || 0), layer: l });
    items.sort((a, b) => (b.d - a.d) || (a.s - b.s));
    const EVD = GM.EV.DRAW;
    for (const inst of insts) if (!inst.$dead && inst.visible) GM.perform(inst, EVD, 72);
    for (const it of items) {
      if (it.layer) { D.drawLayer(it.layer); continue; }
      const inst = it.inst;
      if (inst.$dead || !inst.visible) continue;
      if (!GM.perform(inst, EVD, 0)) GM.F.draw_self(inst, inst);
    }
    for (const inst of insts) if (!inst.$dead && inst.visible) GM.perform(inst, EVD, 73);
    while (targetStack.length) D.surfaceReset();
    if (D.viewRes) { D.viewRes = null; bindTarget(target, offX, offY); }
    D.setOffset(0, 0);
    if (D.debugDraw) D.debugDraw();
    for (const inst of insts) if (!inst.$dead && inst.visible) GM.perform(inst, EVD, 74);
    for (const inst of insts) if (!inst.$dead && inst.visible) GM.perform(inst, EVD, 64);
    for (const inst of insts) if (!inst.$dead && inst.visible) GM.perform(inst, EVD, 75);
    while (targetStack.length) D.surfaceReset();
    if (D.hudDraw) D.hudDraw();
    D.end();
  };

  D.blit = function () {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const cw = canvas.width, ch = canvas.height;
    gl.viewport(0, 0, cw, ch);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const sc = Math.min(cw / D.W, ch / D.H);
    const w = D.W * sc, h = D.H * sc, x = (cw - w) / 2, y = (ch - h) / 2;
    gl.uniform2f(uRes, cw, ch);
    const savedOX = offX, savedOY = offY;
    offX = 0; offY = 0;
    gl.disable(gl.BLEND);
    gl.uniform1f(uAlphaRef, -1);
    gl.uniform4f(uFog, 0, 0, 0, 0);
    useTex(appTex);
    quad(appTex, x, y, x + w, y, x + w, y + h, x, y + h, 0, 1, 1, 0, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 1);
    flush();
    if (D.blendEnabled) gl.enable(gl.BLEND);
    applyAlphaTest();
    if (D.fog != null) D.setFog(true, D.fog);
    gl.colorMask(...D.colorMask);
    offX = savedOX; offY = savedOY;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.uniform2f(uRes, target.w, target.h);
  };

  D.resize = function () {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(320, Math.floor((window.innerWidth || 1280) * dpr));
    const h = Math.max(240, Math.floor((window.innerHeight || 720) * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };

  // sprite_create_from_surface: copy a region of a surface into a new 1-frame sprite
  D.captureSprite = function (x, y, w, h, ox, oy, surfaceId) {
    flush();
    const s = surf(surfaceId === undefined ? APP_SURFACE : surfaceId) || surf(APP_SURFACE);
    w = Math.max(1, Math.min(s.w, Math.round(w))); h = Math.max(1, Math.min(s.h, Math.round(h)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(Math.round(x), s.h - Math.round(y) - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const rows = new Uint8Array(w * h * 4);
    for (let r = 0; r < h; r++) rows.set(px.subarray((h - 1 - r) * w * 4, (h - r) * w * 4), r * w * 4);
    if (s.app) for (let i = 3; i < rows.length; i += 4) rows[i] = 255;
    const t = makeTex(w, h, rows);
    t.w = w; t.h = h;
    const p = D.pages.length;
    D.pages.push(t);
    GM.sprites.push({ name: 'captured', w, h, ox: ox || 0, oy: oy || 0, ml: 0, mr: w - 1, mt: 0, mb: h - 1, sep: 0, speed: 1, speedType: 1,
      frames: [{ p, sx: 0, sy: 0, sw: w, sh: h, tx: 0, ty: 0, tw: w, th: h, bw: w, bh: h }] });
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    return GM.sprites.length - 1;
  };

  // read back the application surface (for screenshots / tests)
  D.snapshot = function () {
    flush();
    gl.bindFramebuffer(gl.FRAMEBUFFER, appFbo);
    const px = new Uint8Array(D.W * D.H * 4);
    gl.readPixels(0, 0, D.W, D.H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    return px;
  };
})();
