/* retro_engine.js — deterministic 270x480 pixel engine, upscaled 4x to 1080x1920.
 *
 * Episode code (episodes/<name>/simulation.js) calls:
 *
 *   Retro.defineSim({
 *     defaultBeats: [{id:'hook', dur:4}, ...],   // used only when no build/timeline.js exists
 *     setup(R)  { R.state = {...} },             // called once (and on preview restart)
 *     update(R, dt) { ... },                     // simulation logic, fixed dt = 1/60
 *     draw(R)   { ... }                          // immediate-mode drawing with R.* primitives
 *   });
 *
 * Render contract (used by pipeline/render_video.py through Playwright):
 *   window.advanceFrame(dt)   -> renders exactly one frame, returns the frame index rendered
 *   window.renderBatch(n)     -> advances n frames, resolves to base64 RGBA of the 270x480 buffer(s)
 *   window.getSfxEvents()     -> every logSfx() call, with frame numbers
 *   window.__simReady / window.__simInfo
 *
 * Nothing here uses wall-clock time or unseeded randomness while rendering, so the
 * same episode always renders the same frames.
 */
(function () {
  'use strict';

  const W = 270, H = 480, SCALE = 4, FPS = 60;
  const OUT_W = W * SCALE, OUT_H = H * SCALE;

  const PAL = {
    bg: '#0B0F19', panel: '#111827', panel2: '#162033', grid: '#1A2438', dim: '#334155',
    mid: '#64748B', text: '#CBD5E1', white: '#F8FAFC', black: '#05070D',
    cyan: '#38BDF8', gold: '#FACC15', coral: '#F43F5E', emerald: '#4ADE80',
    violet: '#A78BFA', orange: '#FB923C',
    cyanDk: '#0E4A6B', goldDk: '#6B5507', coralDk: '#6B1527', emeraldDk: '#14532D'
  };

  // Low-res layout zones (multiply by 4 for 1080x1920 pixels).
  // SAFE: central 900x1420 rectangle from the blueprint (220px top / 280px bottom margins),
  // minus the caption band. Keep important visuals in SAFE.
  const SAFE = { x: 22, y: 55, w: 226, h: 262 };
  const CAPTION_BAND = { x: 22, y: 322, w: 226, h: 50 };   // captions are burnt here by FFmpeg
  const FOOTER = { x: 22, y: 376, w: 226, h: 34 };          // small telemetry strip under captions

  // ---------------------------------------------------------------- 5x7 pixel font
  const G = {
    'A': [14, 17, 17, 31, 17, 17, 17], 'B': [30, 17, 17, 30, 17, 17, 30], 'C': [14, 17, 16, 16, 16, 17, 14],
    'D': [28, 18, 17, 17, 17, 18, 28], 'E': [31, 16, 16, 30, 16, 16, 31], 'F': [31, 16, 16, 30, 16, 16, 16],
    'G': [14, 17, 16, 23, 17, 17, 15], 'H': [17, 17, 17, 31, 17, 17, 17], 'I': [14, 4, 4, 4, 4, 4, 14],
    'J': [7, 2, 2, 2, 2, 18, 12], 'K': [17, 18, 20, 24, 20, 18, 17], 'L': [16, 16, 16, 16, 16, 16, 31],
    'M': [17, 27, 21, 21, 17, 17, 17], 'N': [17, 17, 25, 21, 19, 17, 17], 'O': [14, 17, 17, 17, 17, 17, 14],
    'P': [30, 17, 17, 30, 16, 16, 16], 'Q': [14, 17, 17, 17, 21, 18, 13], 'R': [30, 17, 17, 30, 20, 18, 17],
    'S': [15, 16, 16, 14, 1, 1, 30], 'T': [31, 4, 4, 4, 4, 4, 4], 'U': [17, 17, 17, 17, 17, 17, 14],
    'V': [17, 17, 17, 17, 17, 10, 4], 'W': [17, 17, 17, 21, 21, 21, 10], 'X': [17, 17, 10, 4, 10, 17, 17],
    'Y': [17, 17, 10, 4, 4, 4, 4], 'Z': [31, 1, 2, 4, 8, 16, 31],
    '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
    '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
    '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
    '9': [14, 17, 17, 15, 1, 2, 12],
    ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8],
    ':': [0, 12, 12, 0, 12, 12, 0], ';': [0, 12, 12, 0, 12, 4, 8], '!': [4, 4, 4, 4, 4, 0, 4],
    '?': [14, 17, 1, 2, 4, 0, 4], '-': [0, 0, 0, 14, 0, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0],
    '=': [0, 0, 31, 0, 31, 0, 0], '/': [0, 1, 2, 4, 8, 16, 0], '%': [24, 25, 2, 4, 8, 19, 3],
    '$': [4, 15, 20, 14, 5, 30, 4], "'": [12, 4, 8, 0, 0, 0, 0], '"': [10, 10, 0, 0, 0, 0, 0],
    '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], '<': [2, 4, 8, 16, 8, 4, 2],
    '>': [8, 4, 2, 1, 2, 4, 8], '#': [10, 10, 31, 10, 31, 10, 10], '*': [0, 4, 21, 14, 21, 4, 0],
    '_': [0, 0, 0, 0, 0, 0, 31], '[': [14, 8, 8, 8, 8, 8, 14], ']': [14, 2, 2, 2, 2, 2, 14],
    '|': [4, 4, 4, 4, 4, 4, 4], '&': [12, 18, 20, 8, 21, 18, 13], '^': [4, 10, 17, 0, 0, 0, 0],
    '×': [0, 17, 10, 4, 10, 17, 0], '→': [0, 4, 2, 31, 2, 4, 0], '←': [0, 4, 8, 31, 8, 4, 0],
    '↑': [4, 14, 21, 4, 4, 4, 0], '↓': [0, 4, 4, 4, 21, 14, 4], '•': [0, 0, 14, 14, 14, 0, 0],
    '█': [31, 31, 31, 31, 31, 31, 31], '°': [12, 18, 18, 12, 0, 0, 0], '…': [0, 0, 0, 0, 0, 0, 21], '@': [14, 17, 23, 21, 23, 16, 14], '~': [0, 0, 8, 21, 2, 0, 0]
  };
  const GLYPH_W = 5, GLYPH_H = 7, ADV = 6;
  const UNKNOWN = [31, 17, 17, 17, 17, 17, 31];

  // ---------------------------------------------------------------- RNG
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- params & canvases
  const params = new URLSearchParams(location.search);
  const RENDER = params.get('render') === '1';

  let main, mctx, low, ctx, scanPattern = null;
  let sim = null, booted = false, theme = {};
  const QA = params.get('qa') === '1';
  const hooks = { afterUpdate: [], afterDraw: [], reset: [] };

  const R = {
    W, H, SCALE, FPS, PAL, SAFE, CAPTION_BAND, FOOTER, RENDER,
    frame: 0, t: 0, dt: 1 / FPS, state: {}, crt: true,
    beats: [], total: 30, title: '',
  };

  // ---------------------------------------------------------------- math helpers
  R.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  R.lerp = (a, b, k) => a + (b - a) * k;
  R.map = (v, a, b, c, d, clamp = true) => { let k = (v - a) / (b - a); if (clamp) k = R.clamp(k, 0, 1); return c + (d - c) * k; };
  R.ease = {
    linear: k => k,
    in: k => k * k,
    out: k => 1 - (1 - k) * (1 - k),
    inOut: k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2,
    outBack: k => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); },
    outBounce: k => { const n1 = 7.5625, d1 = 2.75; if (k < 1 / d1) return n1 * k * k; if (k < 2 / d1) return n1 * (k -= 1.5 / d1) * k + 0.75; if (k < 2.5 / d1) return n1 * (k -= 2.25 / d1) * k + 0.9375; return n1 * (k -= 2.625 / d1) * k + 0.984375; },
    step: (k, n) => Math.floor(k * n) / n
  };
  let rng = mulberry32(1337);
  R.seed = (s) => { rng = mulberry32(s | 0); };
  R.rand = (a = 0, b = 1) => a + (b - a) * rng();
  R.randInt = (a, b) => Math.floor(R.rand(a, b + 1));
  R.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  Math.random = () => rng(); // determinism guard: any library randomness is seeded too

  R.fmt = function (n, o = {}) {
    const dec = o.decimals || 0;
    let s;
    if (o.compact && Math.abs(n) >= 1000) {
      const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
      for (const [v, u] of units) if (Math.abs(n) >= v) { s = (n / v).toFixed(o.compactDecimals === undefined ? 1 : o.compactDecimals).replace(/\.0+$/, '') + u; break; }
    } else {
      s = Number(n).toFixed(dec);
      if (o.commas !== false) { const p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = p.join('.'); }
    }
    return (o.prefix || '') + s + (o.suffix || '');
  };

  // ---------------------------------------------------------------- timeline helpers
  function buildTimeline() {
    const T = window.EPISODE_TIMELINE;
    if (T && Array.isArray(T.beats) && T.beats.length) {
      R.beats = T.beats.map(b => ({ ...b }));
      R.total = T.total;
      R.title = T.title || '';
      if (typeof T.crt === 'boolean') R.crt = T.crt;
      R.timeline = T;
      return;
    }
    // Fallback: no TTS has been run yet — use the sim's default beat lengths.
    const defs = (sim && sim.defaultBeats) || [{ id: 'main', dur: 10 }];
    let t = 0.4;
    R.beats = defs.map(d => { const b = { id: d.id, start: t, end: t + d.dur, text: d.text || '' }; t += d.dur; return b; });
    R.total = t + 1.2;
    R.timeline = null;
  }
  R.beat = function (id) {
    const b = R.beats.find(x => x.id === id);
    if (!b) return { id, start: 1e9, end: 1e9, dur: 1, p: 0, active: false, started: false, done: false, local: 0 };
    const dur = Math.max(1e-6, b.end - b.start);
    return {
      id, start: b.start, end: b.end, dur,
      speechEnd: b.speech_end || b.end,
      p: R.clamp((R.t - b.start) / dur, 0, 1),
      active: R.t >= b.start && R.t < b.end,
      started: R.t >= b.start, done: R.t >= b.end,
      local: R.t - b.start
    };
  };
  R.currentBeat = function () {
    let cur = R.beats.length ? R.beats[0].id : null;
    for (const b of R.beats) if (R.t >= b.start) cur = b.id;
    return cur;
  };
  // Word-level sync: time (s) when a narration word is spoken, from faster-whisper timings.
  //   R.wordAt('twenty', 'climax', fallback)      first 'twenty' inside the climax beat
  //   R.wordAt('sixty-four', 'escalation', fb, 1) second occurrence
  // Returns `fallback` when no timeline/words exist (e.g. live preview before TTS).
  const normWord = (w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
  R.word = function (w, beatId, nth = 0) {
    const T = R.timeline; if (!T || !T.words) return null;
    const key = normWord(w); let c = 0;
    for (const x of T.words) {
      if (beatId && x.beat !== beatId) continue;
      if (normWord(x.w) === key) { if (c === nth) return { start: x.start, end: x.end }; c++; }
    }
    return null;
  };
  R.wordAt = (w, beatId, fallback, nth = 0, which = 'start') => { const x = R.word(w, beatId, nth); return x ? x[which] : fallback; };
  // true exactly on the frame where time `time` is first reached
  R.crossed = (time) => R.t >= time && (R.frame - 1) / FPS < time;
  const onceSet = new Set();
  R.once = (key) => { if (onceSet.has(key)) return false; onceSet.add(key); return true; };
  const everyMap = new Map();
  R.every = (key, interval, start = 0) => {
    if (R.t < start || interval <= 0) return false;
    const n = Math.floor((R.t - start) / interval);
    const last = everyMap.has(key) ? everyMap.get(key) : -1;
    if (n > last) { everyMap.set(key, n); return true; }
    return false;
  };
  const tweens = new Map();
  R.tween = (id, target, rate = 0.18) => {
    let v = tweens.has(id) ? tweens.get(id) : target;
    v += (target - v) * (1 - Math.pow(1 - rate, R.dt * 60));
    if (Math.abs(target - v) < 1e-3) v = target;
    tweens.set(id, v);
    return v;
  };

  // ---------------------------------------------------------------- SFX
  R.sfx = (type, pitch = 0, opts) => window.logSfx(type, R.frame, pitch, opts);

  // ---------------------------------------------------------------- camera transform
  // World-space drawing: everything drawn inside R.world(() => {...}) goes through the
  // virtual camera (pan/zoom). Coordinates are transformed THEN snapped to whole pixels,
  // so zooming reveals more geometric detail instead of blurring pixels.
  const rnd = Math.round;
  const cam = { x: W / 2, y: H / 2, z: 1, view: { x: 0, y: 0, w: W, h: H } };
  let camOn = false;
  const TX = (x) => camOn ? (x - cam.x) * cam.z + cam.view.x + cam.view.w / 2 : x;
  const TY = (y) => camOn ? (y - cam.y) * cam.z + cam.view.y + cam.view.h / 2 : y;
  const TS = (s) => camOn ? s * cam.z : s;
  R.toScreen = (x, y) => ({ x: (x - cam.x) * cam.z + cam.view.x + cam.view.w / 2, y: (y - cam.y) * cam.z + cam.view.y + cam.view.h / 2 });
  R.toWorld = (sx, sy) => ({ x: (sx - cam.view.x - cam.view.w / 2) / cam.z + cam.x, y: (sy - cam.view.y - cam.view.h / 2) / cam.z + cam.y });
  R.inWorld = () => camOn;
  R.world = function (fn) {
    const prev = camOn;
    ctx.save();
    ctx.beginPath(); ctx.rect(cam.view.x, cam.view.y, cam.view.w, cam.view.h); ctx.clip();
    camOn = true;
    try { fn(); } finally { camOn = prev; ctx.restore(); }
  };
  R.screen = function (fn) { const prev = camOn; camOn = false; try { return fn(); } finally { camOn = prev; } };
  R._cam = cam;

  // ---------------------------------------------------------------- drawing primitives
  R.clear = (c = PAL.bg) => { ctx.fillStyle = c; ctx.fillRect(0, 0, W, H); };
  R.rect = (x, y, w, h, c) => {
    if (w <= 0 || h <= 0) return;
    const x0 = rnd(TX(x)), y0 = rnd(TY(y));
    const x1 = Math.max(x0 + 1, rnd(TX(x + w))), y1 = Math.max(y0 + 1, rnd(TY(y + h)));
    ctx.fillStyle = c; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  };
  R.px = (x, y, c) => { const s = Math.max(1, rnd(TS(1))); ctx.fillStyle = c; ctx.fillRect(rnd(TX(x)), rnd(TY(y)), s, s); };
  R.hline = (x, y, w, c) => R.rect(x, y, w, 1, c);
  R.vline = (x, y, h, c) => R.rect(x, y, 1, h, c);
  function lineScreen(x0, y0, x1, y1, c, th = 1) {
    x0 = rnd(x0); y0 = rnd(y0); x1 = rnd(x1); y1 = rnd(y1);
    ctx.fillStyle = c;
    const o = Math.floor((th - 1) / 2);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 6000; guard++) {
      ctx.fillRect(x0 - o, y0 - o, th, th);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  // R.line(x0,y0,x1,y1,color, thick?) — thickness is in world units when inside R.world
  R.line = function (x0, y0, x1, y1, c, th = 1) {
    lineScreen(TX(x0), TY(y0), TX(x1), TY(y1), c, Math.max(1, rnd(TS(th))));
  };
  R.dashed = function (x0, y0, x1, y1, c, on = 2, off = 2) {
    const a = { x: TX(x0), y: TY(y0) }, b = { x: TX(x1), y: TY(y1) };
    const len = Math.max(1, Math.round(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))));
    ctx.fillStyle = c;
    for (let i = 0; i <= len; i++) if ((i % (on + off)) < on) ctx.fillRect(rnd(a.x + (b.x - a.x) * i / len), rnd(a.y + (b.y - a.y) * i / len), 1, 1);
  };
  function circleScreen(cx, cy, r, c, fill = true) {
    cx = rnd(cx); cy = rnd(cy); r = Math.max(0, rnd(r));
    ctx.fillStyle = c;
    for (let y = -r; y <= r; y++) {
      const w = Math.floor(Math.sqrt(r * r - y * y + r * 0.8));
      if (fill) ctx.fillRect(cx - w, cy + y, w * 2 + 1, 1);
      else { ctx.fillRect(cx - w, cy + y, 1, 1); ctx.fillRect(cx + w, cy + y, 1, 1); }
    }
  }
  // R.circle(cx,cy,r,color, fill=true | {outline, outlineW, shadow})
  R.circle = function (cx, cy, r, c, o = true) {
    const sx = TX(cx), sy = TY(cy), sr = TS(r);
    if (typeof o === 'object' && o) {
      if (o.shadow) circleScreen(sx + 2, sy + 2, sr + (o.outlineW || 0), o.shadow === true ? PAL.black : o.shadow);
      if (o.outline) circleScreen(sx, sy, sr + (o.outlineW || 2), o.outline);
      circleScreen(sx, sy, sr, c, true);
    } else circleScreen(sx, sy, sr, c, o !== false);
  };
  // Filled annulus (bearings, bores, pipes in cross-section)
  R.ring = function (cx, cy, r0, r1, c) {
    const sx = rnd(TX(cx)), sy = rnd(TY(cy)), a = TS(r0), b = rnd(TS(r1));
    ctx.fillStyle = c;
    for (let y = -b; y <= b; y++) {
      const wo = Math.floor(Math.sqrt(Math.max(0, b * b - y * y + b * 0.8)));
      const wi2 = a * a - y * y;
      if (wi2 <= 0) { ctx.fillRect(sx - wo, sy + y, wo * 2 + 1, 1); continue; }
      const wi = Math.ceil(Math.sqrt(wi2));
      if (wo > wi) { ctx.fillRect(sx - wo, sy + y, wo - wi, 1); ctx.fillRect(sx + wi + 1, sy + y, wo - wi, 1); }
    }
  };
  // ---- crisp scanline polygon fill (no anti-aliasing), screen-space
  function fillPolyScreen(pts, c, dx = 0, dy = 0) {
    const n = pts.length; if (n < 3) return;
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    const y0 = Math.max(0 - dy, Math.ceil(minY - 0.5)), y1 = Math.min(H - 1 - dy, Math.floor(maxY - 0.5));
    ctx.fillStyle = c;
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5; xs.length = 0;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + (yc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.ceil(xs[k] - 0.5), xb = Math.floor(xs[k + 1] - 0.5);
        if (xb >= xa) ctx.fillRect(xa + dx, y + dy, xb - xa + 1, 1);
      }
    }
  }
  // R.poly([[x,y],...], color, {outline:'#05070D', outlineW:2, shadow:true|color, shadowOffset:2})
  R.poly = function (pts, c, o = {}) {
    const sp = pts.map(p => [TX(p[0]), TY(p[1])]);
    if (o.shadow) { const so = o.shadowOffset || 2; fillPolyScreen(sp, o.shadow === true ? PAL.black : o.shadow, so, so); }
    if (o.outline) {
      const ow = o.outlineW === undefined ? 2 : o.outlineW;
      for (let k = 1; k <= ow; k++) for (const [ox, oy] of [[k, 0], [-k, 0], [0, k], [0, -k]]) fillPolyScreen(sp, o.outline, ox, oy);
      for (const [ox, oy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) fillPolyScreen(sp, o.outline, ox, oy);
    }
    if (c) fillPolyScreen(sp, c);
  };
  R.polyline = function (pts, c, th = 1) { for (let i = 0; i + 1 < pts.length; i++) R.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], c, th); };
  // Rotated rectangle centred at (cx,cy) — rods, pistons, valves, levers
  R.rotRect = function (cx, cy, w, h, ang, c, o = {}) {
    const ca = Math.cos(ang), sa = Math.sin(ang), hw = w / 2, hh = h / 2;
    const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
    R.poly(pts, c, o);
    return pts;
  };
  // Bar between two points with thickness (connecting rods, linkages, beams)
  R.link = function (x0, y0, x1, y1, thick, c, o = {}) {
    const ang = Math.atan2(y1 - y0, x1 - x0), len = Math.hypot(x1 - x0, y1 - y0);
    return R.rotRect((x0 + x1) / 2, (y0 + y1) / 2, len + thick, thick, ang, c, o);
  };
  // Chunky pixel border box with notched corners + hard drop shadow
  R.box = function (x, y, w, h, o = {}) {
    const t = o.thick || 1, border = o.border === undefined ? PAL.dim : o.border;
    if (!camOn) { x = rnd(x); y = rnd(y); w = rnd(w); h = rnd(h); }
    if (o.shadow !== false) R.rect(x + 2, y + 2, w, h, o.shadow || PAL.black);
    if (o.fill !== null) R.rect(x + t, y + t, w - 2 * t, h - 2 * t, o.fill || PAL.panel);
    if (border) {
      R.rect(x + 1, y, w - 2, t, border); R.rect(x + 1, y + h - t, w - 2, t, border);
      R.rect(x, y + 1, t, h - 2, border); R.rect(x + w - t, y + 1, t, h - 2, border);
    }
    if (o.highlight) R.rect(x + t, y + t, w - 2 * t, 1, o.highlight);
  };
  R.border = (x, y, w, h, c, thick = 1) => R.box(x, y, w, h, { fill: null, border: c, thick, shadow: false });
  R.grid = function (x, y, w, h, step, c) {
    for (let gx = x; gx <= x + w; gx += step) R.rect(gx, y, 1 / (camOn ? cam.z : 1), h, c);
    for (let gy = y; gy <= y + h; gy += step) R.rect(x, gy, w, 1 / (camOn ? cam.z : 1), c);
  };
  R.dither = function (x, y, w, h, c, phase = 0) { // 50% checkerboard fill (screen-pixel pattern)
    const x0 = rnd(TX(x)), y0 = rnd(TY(y)), x1 = rnd(TX(x + w)), y1 = rnd(TY(y + h));
    ctx.fillStyle = c;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0 + ((yy + phase) & 1); xx < x1; xx += 2) ctx.fillRect(xx, yy, 1, 1);
  };
  R.image = function (img, x, y, w, h) {
    const x0 = rnd(TX(x)), y0 = rnd(TY(y));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x0, y0, rnd(TX(x + (w || img.width))) - x0, rnd(TY(y + (h || img.height))) - y0);
  };
  R._internal = { TX, TY, TS, fillPolyScreen, lineScreen, circleScreen, get ctx() { return ctx; } };

  // ---- text
  R.textWidth = (str, scale = 1, spacing = 1) => {
    const lines = String(str).split('\n');
    return Math.max(...lines.map(l => l.length ? (l.length * (GLYPH_W + spacing) - spacing) * scale : 0));
  };
  function drawGlyph(g, x, y, s) {
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = g[row]; if (!bits) continue;
      let run = -1;
      for (let col = 0; col <= GLYPH_W; col++) {
        const on = col < GLYPH_W && (bits >> (GLYPH_W - 1 - col)) & 1;
        if (on && run < 0) run = col;
        if (!on && run >= 0) { ctx.fillRect(x + run * s, y + row * s, (col - run) * s, s); run = -1; }
      }
    }
  }
  R.text = function (str, x, y, o = {}) {
    const s = o.scale || 1, sp = o.spacing === undefined ? 1 : o.spacing;
    const color = o.color || PAL.white, lh = (o.lineHeight || 9) * s;
    const lines = String(str).toUpperCase().split('\n');
    if (camOn) { x = TX(x); y = TY(y); }
    let maxW = 0;
    lines.forEach((line, li) => {
      const w = line.length ? (line.length * (GLYPH_W + sp) - sp) * s : 0;
      maxW = Math.max(maxW, w);
      let lx = rnd(x); const ly = rnd(y) + li * lh;
      if (o.align === 'center') lx = rnd(x - w / 2); else if (o.align === 'right') lx = rnd(x - w);
      const passes = [];
      if (o.shadow !== false) passes.push([o.shadow && o.shadow !== true ? o.shadow : PAL.black, Math.max(1, s >> 1)]);
      if (o.outline) passes.push(['outline', 0]);
      passes.push([color, 0]);
      for (const [c, off] of passes) {
        if (c === 'outline') {
          ctx.fillStyle = o.outline;
          for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            let cx = lx; for (const ch of line) { drawGlyph(G[ch] || UNKNOWN, cx + ox * s, ly + oy * s, s); cx += (GLYPH_W + sp) * s; }
          }
          continue;
        }
        ctx.fillStyle = c;
        let cx = lx + off;
        for (const ch of line) { drawGlyph(G[ch] || UNKNOWN, cx, ly + off, s); cx += (GLYPH_W + sp) * s; }
      }
    });
    return maxW;
  };
  // Typewriter reveal: shows the first k characters of str for progress p (0..1)
  R.typeText = function (str, x, y, p, o = {}) {
    const n = Math.floor(R.clamp(p, 0, 1) * str.length);
    return R.text(str.slice(0, n), x, y, o);
  };
  // Colored tag label (filled box, dark text)
  R.tag = function (str, x, y, color = PAL.cyan, o = {}) {
    const s = o.scale || 1, w = R.textWidth(str.toUpperCase(), s) + 6 * s, h = 7 * s + 5;
    let bx = x; if (o.align === 'center') bx = x - w / 2; else if (o.align === 'right') bx = x - w;
    R.rect(bx + 1, y + 1, w, h, PAL.black);
    R.rect(bx, y, w, h, color);
    R.text(str, bx + 3 * s, y + 3, { color: o.textColor || PAL.bg, scale: s, shadow: false });
    return { x: bx, y, w, h };
  };

  // ---- HUD widgets
  R.bar = function (x, y, w, h, frac, o = {}) {
    const color = o.color || PAL.emerald;
    R.box(x, y, w, h, { fill: o.bg || PAL.black, border: o.border || PAL.dim, shadow: o.shadow });
    const iw = w - 4, ih = h - 4, fw = Math.round(iw * R.clamp(frac, 0, 1));
    const seg = o.segment === undefined ? 4 : o.segment;
    if (seg > 0) {
      for (let sx = 0; sx < fw; sx += seg) R.rect(x + 2 + sx, y + 2, Math.min(seg - 1, fw - sx), ih, color);
    } else R.rect(x + 2, y + 2, fw, ih, color);
    if (fw > 0 && ih > 2) R.rect(x + 2, y + 2, fw, 1, 'rgba(255,255,255,0.35)');
  };
  // Animated telemetry counter. `value` = true value; the display rolls toward it.
  const counterLast = new Map();
  R.counter = function (id, x, y, value, o = {}) {
    const shown = o.smooth === false ? value : R.tween('ctr:' + id, value, o.rate || 0.25);
    const txt = R.fmt(o.integer === false ? shown : Math.round(shown), o);
    const prev = counterLast.get(id);
    counterLast.set(id, txt);
    const s = o.scale || 2, align = o.align || 'left';
    let yy = y;
    if (o.label) { R.text(o.label, x, y, { color: o.labelColor || PAL.mid, align }); yy += 10; }
    const changed = prev !== undefined && prev !== txt;
    R.text(txt, x, yy, { color: changed && o.blink !== false ? PAL.white : (o.color || PAL.cyan), scale: s, align });
    return txt;
  };
  // Top-vs-Bottom comparison layout inside the SAFE area
  R.split = function (o = {}) {
    const area = o.area || SAFE, header = o.header === undefined ? 14 : o.header, gap = o.gap === undefined ? 8 : o.gap;
    const ph = Math.floor((area.h - header - gap) / 2);
    const top = { x: area.x, y: area.y + header, w: area.w, h: ph };
    const bottom = { x: area.x, y: area.y + header + ph + gap, w: area.w, h: ph };
    const colors = [o.topColor || PAL.cyan, o.bottomColor || PAL.gold];
    [top, bottom].forEach((p, i) => {
      R.box(p.x, p.y, p.w, p.h, { fill: o.fill || PAL.panel, border: o.border || colors[i] + '88' });
      const label = i === 0 ? o.topLabel : o.bottomLabel;
      if (label) R.tag(label, p.x + 4, p.y - 5, colors[i]);
      p.inner = { x: p.x + 4, y: p.y + 10, w: p.w - 8, h: p.h - 14 };
      p.color = colors[i];
    });
    if (o.vs !== false) {
      const vy = top.y + top.h + Math.floor(gap / 2) - 6;
      R.tag('VS', area.x + area.w - 4, vy, PAL.coral, { align: 'right', textColor: PAL.white });
    }
    return { top, bottom, header: { x: area.x, y: area.y, w: area.w, h: header } };
  };
  // Floating callout label with a pointer tail at (x, y)
  R.callout = function (str, x, y, o = {}) {
    const color = o.color || PAL.gold, dir = o.dir || 'down', s = o.scale || 1;
    const appear = o.appear === undefined ? 1 : R.clamp(o.appear, 0, 1);
    if (appear <= 0) return;
    const bob = o.bob === false ? 0 : Math.round(Math.sin(R.t * 6 + (o.phase || 0)) * 1);
    const tw = R.textWidth(str.toUpperCase(), s), w = tw + 8, h = 7 * s + 6;
    const pop = Math.round((1 - R.ease.outBack(appear)) * 6);
    let bx, by;
    if (dir === 'down') { bx = x - w / 2; by = y - h - 5 - bob - pop; }
    else if (dir === 'up') { bx = x - w / 2; by = y + 5 + bob + pop; }
    else if (dir === 'left') { bx = x + 5 + bob; by = y - h / 2; }
    else { bx = x - w - 5 - bob; by = y - h / 2; }
    bx = R.clamp(bx, 2, W - w - 2);
    R.box(bx, by, w, h, { fill: PAL.bg, border: color });
    R.text(str, bx + 4, by + 3, { color, scale: s, shadow: false });
    // tail
    ctx.fillStyle = color;
    if (dir === 'down') for (let i = 0; i < 4; i++) ctx.fillRect(rnd(x) - (3 - i), rnd(by + h + i), (3 - i) * 2 + 1, 1);
    else if (dir === 'up') for (let i = 0; i < 4; i++) ctx.fillRect(rnd(x) - i, rnd(by - 4 + i), i * 2 + 1, 1);
    else if (dir === 'left') for (let i = 0; i < 4; i++) ctx.fillRect(rnd(bx - 4 + i), rnd(y) - i, 1, i * 2 + 1);
    else for (let i = 0; i < 4; i++) ctx.fillRect(rnd(bx + w + 3 - i), rnd(y) - i, 1, i * 2 + 1);
  };
  // Header title strip at the top of the safe area
  R.title = function (str, o = {}) {
    const y = o.y === undefined ? SAFE.y : o.y;
    R.text(str, W / 2, y, { color: o.color || PAL.white, scale: o.scale || 1, align: 'center' });
  };

  // HUD widgets always draw in screen space (callout anchors given in world coords are converted)
  ['tag', 'counter', 'bar', 'split', 'title'].forEach((name) => {
    const orig = R[name];
    R[name] = function (...a) { return R.screen(() => orig.apply(R, a)); };
  });
  { const orig = R.callout;
    R.callout = function (str, x, y, o) { if (camOn) { const p = R.toScreen(x, y); x = p.x; y = p.y; } return R.screen(() => orig.call(R, str, x, y, o)); }; }

  // ---- FX: flash, shake, particles
  let flashColor = null, flashFrames = 0, flashMax = 1, shakeAmt = 0, shakeFrames = 0, shakeMax = 1;
  R.flash = (color = PAL.white, frames = 8) => { flashColor = color; flashFrames = frames; flashMax = frames; };
  R.shake = (amt = 3, frames = 12) => { shakeAmt = amt; shakeFrames = frames; shakeMax = frames; };
  const particles = [];
  R.burst = function (x, y, n = 16, color = PAL.gold, speed = 1.6, o = {}) {
    if (camOn) { const p = R.toScreen(x, y); x = p.x; y = p.y; }
    for (let i = 0; i < n; i++) {
      const a = R.rand(0, Math.PI * 2), v = R.rand(0.3, 1) * speed;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (o.lift || 0.6), life: R.randInt(18, 40), color: Array.isArray(color) ? R.pick(color) : color, g: o.gravity === undefined ? 0.06 : o.gravity, size: o.size || 1 });
    }
  };
  function stepParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life--;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      R.rect(p.x, p.y, p.size, p.size, p.color);
    }
  }

  // ---------------------------------------------------------------- frame stepping
  function renderFrame(dt) {
    R.dt = dt;
    R.t = R.frame / FPS;
    R.clear(PAL.bg);
    let sx = 0, sy = 0;
    if (shakeFrames > 0) {
      const k = shakeFrames / shakeMax;
      sx = Math.round(R.rand(-1, 1) * shakeAmt * k); sy = Math.round(R.rand(-1, 1) * shakeAmt * k);
      shakeFrames--;
    }
    ctx.save();
    ctx.translate(sx, sy);
    if (sim.update) sim.update(R, dt);
    for (const h of hooks.afterUpdate) h(R, dt);
    if (theme.background) theme.background(R);
    if (sim.draw) sim.draw(R);
    camOn = false;
    for (const h of hooks.afterDraw) h(R);
    stepParticles();
    ctx.restore();
    if (theme.overlay) theme.overlay(R);
    if (flashFrames > 0) {
      ctx.globalAlpha = 0.55 * (flashFrames / flashMax);
      R.rect(0, 0, W, H, flashColor);
      ctx.globalAlpha = 1;
      flashFrames--;
    }
    if (QA) drawQaGuides();
    window.RetroAudio && window.RetroAudio.endFrame && window.RetroAudio.endFrame(R.frame);
    const rendered = R.frame;
    R.frame++;
    return rendered;
  }

  function drawQaGuides() {
    // QA overlay (preview-only renders): safe zone, caption band, footer — must never be crossed by key visuals
    const dash = (x, y, w, h, c) => { R.dashed(x, y, x + w, y, c, 3, 2); R.dashed(x, y + h, x + w, y + h, c, 3, 2); R.dashed(x, y, x, y + h, c, 3, 2); R.dashed(x + w, y, x + w, y + h, c, 3, 2); };
    dash(SAFE.x, SAFE.y, SAFE.w, SAFE.h, '#F43F5E');
    dash(CAPTION_BAND.x, CAPTION_BAND.y, CAPTION_BAND.w, CAPTION_BAND.h, '#A78BFA');
    dash(FOOTER.x, FOOTER.y, FOOTER.w, FOOTER.h, '#FB923C');
    R.text(`QA ${R.t.toFixed(2)}S ${R.currentBeat() || ''}`, 2, 2, { color: '#F43F5E', shadow: false });
  }

  function blit() {
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(low, 0, 0, OUT_W, OUT_H);
    if (R.crt) {
      if (!scanPattern) {
        const pc = document.createElement('canvas'); pc.width = 1; pc.height = SCALE;
        const pctx = pc.getContext('2d'); pctx.fillStyle = 'rgba(0,0,0,0.22)'; pctx.fillRect(0, SCALE - 1, 1, 1);
        scanPattern = mctx.createPattern(pc, 'repeat');
      }
      mctx.fillStyle = scanPattern; mctx.fillRect(0, 0, OUT_W, OUT_H);
    }
  }

  function resetState() {
    R.frame = 0; R.t = 0; R.state = {};
    onceSet.clear(); everyMap.clear(); tweens.clear(); counterLast.clear(); particles.length = 0;
    flashFrames = 0; shakeFrames = 0;
    R.seed(sim.seed || parseInt(params.get('seed') || '1337', 10));
    window.RetroAudio && window.RetroAudio.clear();
    for (const h of hooks.reset) h(R);
    if (sim.setup) sim.setup(R);
  }

  // ---------------------------------------------------------------- public API
  window.advanceFrame = function (dt) {
    const f = renderFrame(dt || 1 / FPS);
    if (!RENDER) blit();
    return f;
  };
  window.renderBatch = function (n) {
    const frameBytes = W * H * 4;
    const buf = new Uint8Array(frameBytes * n);
    for (let k = 0; k < n; k++) {
      renderFrame(1 / FPS);
      buf.set(ctx.getImageData(0, 0, W, H).data, k * frameBytes);
    }
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = fr.result; resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(new Blob([buf]));
    });
  };

  const Retro = {
    W, H, SCALE, FPS, PAL, SAFE, CAPTION_BAND, FOOTER, R,
    defineSim(def) { sim = def; },
    defineTheme(def) { theme = def || {}; },        // channels/<slug>/theme.js
    hooks,
    boot() {
      if (booted) return; booted = true;
      main = document.getElementById('screen');
      main.width = OUT_W; main.height = OUT_H;
      mctx = main.getContext('2d');
      low = document.createElement('canvas'); low.width = W; low.height = H;
      ctx = low.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      R.ctx = ctx;
      if (!sim) sim = TEST_CARD;
      if (theme.palette) Object.assign(PAL, theme.palette);   // channel palette overrides engine defaults
      R.theme = theme;
      if (theme.setup) theme.setup(R);
      buildTimeline();
      if (params.get('crt') === '0') R.crt = false;
      resetState();
      window.__simInfo = { theme: theme.name || null, total: R.total, fps: FPS, width: W, height: H, scale: SCALE, crt: R.crt, beats: R.beats, title: R.title, fromTimeline: !!R.timeline };
      window.__simReady = true;
      if (!RENDER) startPreview();
    },
    reset: resetState
  };
  window.Retro = Retro;

  // ---------------------------------------------------------------- preview mode (open the HTML in a browser)
  function startPreview() {
    const overlay = document.getElementById('overlay');
    const hud = document.getElementById('hud');
    const tlParam = params.get('timeline');
    let audio = null;
    if (tlParam && R.timeline) {
      audio = new Audio(tlParam.replace(/[^/\\]+$/, '') + 'narration.wav');
      audio.preload = 'auto';
    }
    const totalFrames = Math.ceil(R.total * FPS);
    let running = false, paused = false, t0 = 0, pausedAt = 0;
    renderFrame(1 / FPS); blit(); resetState(); // poster frame
    function clock() { return audio && !audio.error && audio.readyState > 0 ? audio.currentTime : (performance.now() - t0) / 1000; }
    function start() {
      window.RetroAudio && window.RetroAudio.unlock();
      resetState();
      t0 = performance.now(); running = true; paused = false;
      if (audio) { audio.currentTime = 0; audio.play().catch(() => { audio = null; }); }
      if (overlay) overlay.style.display = 'none';
    }
    function seek(sec) {
      const target = R.clamp(Math.floor((clock() + sec) * FPS), 0, totalFrames - 1);
      window.RetroAudio && window.RetroAudio.setLive(false);
      if (target < R.frame) resetState();
      while (R.frame < target) renderFrame(1 / FPS);
      window.RetroAudio && window.RetroAudio.setLive(true);
      t0 = performance.now() - target / FPS * 1000;
      if (audio) audio.currentTime = target / FPS;
    }
    if (overlay) overlay.addEventListener('click', start);
    window.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        if (!running) return start();
        paused = !paused;
        if (paused) { pausedAt = clock(); audio && audio.pause(); }
        else { t0 = performance.now() - pausedAt * 1000; audio && audio.play(); }
        e.preventDefault();
      } else if (e.key === 'r' || e.key === 'R') start();
      else if (e.key === 'c' || e.key === 'C') { R.crt = !R.crt; blit(); }
      else if (e.key === 'ArrowRight' && running) seek(5);
      else if (e.key === 'ArrowLeft' && running) seek(-5);
    });
    (function loop() {
      if (running && !paused) {
        const target = Math.min(totalFrames, Math.floor(clock() * FPS) + 1);
        let guard = 0;
        while (R.frame < target && guard++ < 10) renderFrame(1 / FPS);
        blit();
        if (R.frame >= totalFrames) { running = false; if (overlay) { overlay.textContent = 'END — CLICK OR PRESS R TO REPLAY'; overlay.style.display = 'flex'; } }
      }
      if (hud) hud.textContent = `t=${R.t.toFixed(2)}s / ${R.total.toFixed(2)}s  frame ${R.frame}  beat: ${R.currentBeat() || '-'}  ${R.timeline ? '' : '(no timeline: default beats)'}  [space] play/pause [R] restart [C] CRT [←/→] seek`;
      requestAnimationFrame(loop);
    })();
  }

  // ---------------------------------------------------------------- built-in test card (no ?sim= given)
  const TEST_CARD = {
    defaultBeats: [{ id: 'main', dur: 8 }],
    setup(R) { R.state.n = 0; },
    update(R) { if (R.every('tick', 0.5)) { R.state.n++; R.sfx('tick', R.state.n % 12); } },
    draw(R) {
      if (!R.theme.background) R.grid(0, 0, W, H, 15, PAL.grid);
      R.title('RETRO ENGINE TEST CARD');
      R.text('ABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789 .,:;!?-+=/%$\'"()<>#*_[]|&^×→←↑↓•°', SAFE.x, SAFE.y + 14, { color: PAL.text });
      const sw = ['cyan', 'gold', 'coral', 'emerald', 'violet', 'orange'];
      sw.forEach((k, i) => R.rect(SAFE.x + i * 36, SAFE.y + 40, 32, 12, PAL[k]));
      R.counter('n', SAFE.x, SAFE.y + 62, R.state.n * 1234, { label: 'COUNTER', scale: 2 });
      R.bar(SAFE.x, SAFE.y + 95, SAFE.w, 12, (R.t % 4) / 4, { color: PAL.cyan });
      R.callout('CALLOUT', 135, SAFE.y + 140, { color: PAL.coral });
      R.border(CAPTION_BAND.x, CAPTION_BAND.y, CAPTION_BAND.w, CAPTION_BAND.h, PAL.dim);
      R.text('CAPTION BAND', W / 2, CAPTION_BAND.y + 20, { color: PAL.mid, align: 'center' });
      R.border(SAFE.x, SAFE.y, SAFE.w, SAFE.h, PAL.coralDk);
    }
  };
})();
