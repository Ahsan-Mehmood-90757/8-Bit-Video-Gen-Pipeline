/* depth_fx_v3.js — visual density layer: time control, 2.5D cutaway walls, motion trails, pooled particles,
 * flow dots and the speed/mode HUD badge. Loaded after attention_v3.js.
 *
 * TIME CONTROL (also drives the music bed — see pipeline_v3/synth_v3.py + engine_v3/synth_engine.js)
 *   R.setTimeScale(scale, ramp=0.35)   1.0 = real time, 0.15 = slow-mo; eases over `ramp` seconds
 *   R.setStepMode(on)                  "STEP MODE" (discrete stepping); badge + groove react
 *   R.timeScale, R.simDt (= dt * timeScale), R.simTime (accumulated simulation time)
 *   The current scale is logged every frame (window.logTimeScaleV3) so the render's groove slows down
 *   in pitch and tempo, and impact envelopes stretch, exactly where the picture is in slow-mo.
 *
 * 2.5D CUTAWAY
 *   R.wall25d(x, y, w, h, {depth, dir:[dx,dy], face, top, side, hatch, hatchColor, shadow, edge})
 *       extruded / bevelled cross-section block: drop shadow, lit top face, dark side face,
 *       hatched cut face and a highlight edge (world coords inside R.world)
 *
 * MOTION
 *   R.trail(id, x, y, {n=8, color, size=2})     last N positions of a fast part at decaying alpha (call every frame)
 *   R.emit(n, {x, y, angle, spread, speed:[a,b], drag, life:[a,b], gravity, kind, color, size})
 *       kind: 'spark' (streak) | 'dot' | 'packet' (tiny data block) | 'ember' (1 px); color may be an array
 *   R.stream(id, {x, y, rate, ...emit opts})   continuous emitter, `rate` particles per second (call every frame)
 *   R.flowDots(points, {speed, spacing, color, size, phase})   dots streaming along a polyline
 *   Particles live in a fixed pool (900), move with simDt (so they slow down in slow-mo) and use the seeded RNG.
 *
 * HUD
 *   R.speedBadge({x, y, from})   REAL SPEED / SLOW-MO ×0.15 / STEP MODE — pops when the mode changes, then dims
 */
(function () {
  'use strict';
  const Retro = window.Retro, R = Retro.R, I = R._internal;
  const rnd = Math.round;

  // ================================================================== time control
  let tsTarget = 1, tsFrom = 1, tsT0 = 0, tsRamp = 0.35, stepMode = false, modeT = 0, lastMode = 'real';
  R.timeScale = 1; R.simDt = 1 / 60; R.simTime = 0; R.stepMode = false;
  R.setTimeScale = function (scale, ramp = 0.35) {
    scale = Math.max(0.02, Math.min(4, +scale));
    if (Math.abs(scale - tsTarget) < 1e-4) return;
    tsFrom = R.timeScale; tsTarget = scale; tsT0 = R.t; tsRamp = Math.max(1e-3, ramp);
  };
  R.setStepMode = function (on) { stepMode = !!on; R.stepMode = stepMode; };
  function modeOf() { return stepMode ? 'step' : (R.timeScale < 0.97 ? 'slow' : 'real'); }
  Retro.hooks.afterUpdate.unshift(() => {            // runs before camera etc. so simDt is ready for drawing
    const k = R.clamp((R.t - tsT0) / tsRamp, 0, 1);
    R.timeScale = tsFrom + (tsTarget - tsFrom) * R.ease.inOut(k);
    R.simDt = R.dt * R.timeScale;
    R.simTime += R.simDt;
    const m = modeOf();
    if (m !== lastMode) { lastMode = m; modeT = R.t; }
    if (window.logTimeScaleV3) window.logTimeScaleV3(R.frame, R.timeScale, stepMode);
  });

  // ================================================================== colour helpers
  function hex(h) { const n = parseInt(String(h).slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function shade(h, f) {      // f > 0 lighten toward white, f < 0 darken toward black
    const c = hex(h).map(v => f >= 0 ? v + (255 - v) * f : v * (1 + f));
    return '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  R.shade = shade;

  // ================================================================== 2.5D extruded cutaway walls
  R.wall25d = function (x, y, w, h, o = {}) {
    const face = o.face || R.PAL.panel2, depth = o.depth === undefined ? 6 : o.depth;
    const dir = o.dir || [0.75, -0.75], dx = depth * dir[0], dy = depth * dir[1];
    const top = o.top || shade(face, 0.28), side = o.side || shade(face, -0.35);
    if (o.shadow !== false) R.poly([[x + 3, y + 3], [x + w + dx + 3, y + dy + 3], [x + w + dx + 3, y + h + dy + 3], [x + w + 3, y + h + 3], [x + 3, y + h + 3]], R.PAL.black);
    if (dy < 0) R.poly([[x, y], [x + w, y], [x + w + dx, y + dy], [x + dx, y + dy]], top);                 // lit top face
    else R.poly([[x, y + h], [x + w, y + h], [x + w + dx, y + h + dy], [x + dx, y + h + dy]], side);
    if (dx > 0) R.poly([[x + w, y], [x + w + dx, y + dy], [x + w + dx, y + h + dy], [x + w, y + h]], side);   // dark side face
    else R.poly([[x, y], [x + dx, y + dy], [x + dx, y + h + dy], [x, y + h]], top);
    R.rect(x, y, w, h, face);                                                                                 // cut face
    if (o.hatch !== false) R.hatch(x + 1, y + 1, w - 2, h - 2, o.hatchColor || shade(face, -0.25), o.hatchSpacing || 3);
    const edge = o.edge || shade(face, 0.55);
    R.rect(x, y, w, 1, edge); R.rect(x, y, 1, h, edge);                                                      // highlight edge
    R.rect(x, y + h - 1, w, 1, shade(face, -0.45));
  };

  // ================================================================== motion trails
  const trails = new Map();
  R.trail = function (id, x, y, o = {}) {
    const n = o.n || 8, size = o.size || 2, color = o.color || R.PAL.cyan;
    let T = trails.get(id);
    if (!T || R.frame - T.last > 2) { T = { pts: [], last: R.frame }; trails.set(id, T); }
    T.pts.push([x, y]); T.last = R.frame;
    if (T.pts.length > n + 1) T.pts.shift();
    const ctx = I.ctx;
    for (let i = 0; i < T.pts.length - 1; i++) {
      const k = (i + 1) / T.pts.length;                     // older -> fainter and smaller
      ctx.save(); ctx.globalAlpha *= 0.12 + 0.55 * k;
      const s = Math.max(1, rnd(size * (0.4 + 0.6 * k)));
      R.rect(T.pts[i][0] - s / 2, T.pts[i][1] - s / 2, s, s, color);
      ctx.restore();
    }
  };

  // ================================================================== pooled particles
  const POOL = 900, pool = [];
  for (let i = 0; i < POOL; i++) pool.push({ on: false });
  let cursor = 0;
  const streams = new Map();
  const range = (v, d) => Array.isArray(v) ? R.rand(v[0], v[1]) : (v === undefined ? d : v);
  R.emit = function (n, o = {}) {
    let x = o.x || 0, y = o.y || 0;
    if (!R.inWorld()) { const p = R.toWorld(x, y); x = p.x; y = p.y; }
    for (let k = 0; k < n; k++) {
      let P = null;
      for (let s = 0; s < POOL; s++) { const c = pool[(cursor + s) % POOL]; if (!c.on) { P = c; cursor = (cursor + s + 1) % POOL; break; } }
      if (!P) { P = pool[cursor]; cursor = (cursor + 1) % POOL; }           // pool full: recycle the oldest slot
      const ang = (o.angle === undefined ? -Math.PI / 2 : o.angle) + R.rand(-1, 1) * (o.spread === undefined ? Math.PI : o.spread);
      const sp = range(o.speed, 1.2), life = range(o.life, 0.6);
      const col = Array.isArray(o.color) ? R.pick(o.color) : (o.color || R.PAL.gold);
      Object.assign(P, { on: true, x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, drag: o.drag === undefined ? 0.06 : o.drag,
        g: o.gravity || 0, life, max: life, kind: o.kind || 'spark', color: col, size: o.size || 1 });
    }
  };
  R.stream = function (id, o = {}) {
    const S = streams.get(id) || { acc: 0 };
    S.acc += (o.rate || 20) * R.simDt;
    const n = Math.floor(S.acc); S.acc -= n;
    streams.set(id, S);
    if (n > 0) R.emit(n, o);
  };
  function stepAndDraw() {
    const f = R.simDt * 60, ctx = I.ctx;
    R.world(() => {
      for (const P of pool) {
        if (!P.on) continue;
        P.vx *= Math.pow(1 - P.drag, f); P.vy *= Math.pow(1 - P.drag, f); P.vy += P.g * f;
        P.x += P.vx * f; P.y += P.vy * f; P.life -= R.simDt;
        if (P.life <= 0) { P.on = false; continue; }
        ctx.save(); ctx.globalAlpha *= R.clamp(P.life / P.max, 0, 1);
        if (P.kind === 'spark') R.line(P.x, P.y, P.x - P.vx * 1.6, P.y - P.vy * 1.6, P.color);
        else if (P.kind === 'packet') { R.rect(P.x - 2, P.y - 1.5, 4, 3, R.PAL.black); R.rect(P.x - 1.5, P.y - 1, 3, 2, P.color); }
        else if (P.kind === 'dot') R.rect(P.x - P.size / 2, P.y - P.size / 2, Math.max(2, P.size), Math.max(2, P.size), P.color);
        else R.px(P.x, P.y, P.color);
        ctx.restore();
      }
    });
  }
  // dots streaming along a polyline (pure function of simTime -> slow-mo aware)
  R.flowDots = function (points, o = {}) {
    const segs = []; let total = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const l = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
      segs.push({ a: points[i], b: points[i + 1], l, s: total }); total += l;
    }
    if (total <= 0) return;
    const spacing = o.spacing || 8, size = o.size || 2, speed = o.speed === undefined ? 30 : o.speed;
    const off = ((R.simTime * speed + (o.phase || 0)) % spacing + spacing) % spacing;
    for (let d = off; d < total; d += spacing) {
      const sg = segs.find(q => d >= q.s && d <= q.s + q.l) || segs[segs.length - 1];
      const k = (d - sg.s) / sg.l;
      const x = sg.a[0] + (sg.b[0] - sg.a[0]) * k, y = sg.a[1] + (sg.b[1] - sg.a[1]) * k;
      R.rect(x - size / 2, y - size / 2, size, size, o.color || R.PAL.cyan);
    }
  };

  // ================================================================== speed / mode badge
  R.speedBadge = function (o = {}) {
    const m = modeOf();
    const txt = m === 'step' ? 'STEP MODE' : m === 'slow' ? 'SLOW-MO ×' + R.timeScale.toFixed(2).replace(/0$/, '') : 'REAL SPEED';
    const color = m === 'step' ? R.PAL.violet || R.PAL.cyan : m === 'slow' ? R.PAL.gold : R.PAL.emerald;
    const A = R.SAFE, w = R.textWidth(txt) + 8;
    const x = o.x === undefined ? A.x + A.w - 4 - w / 2 : o.x, y = o.y === undefined ? A.y + 10 : o.y;
    if (o.from !== undefined && R.t < o.from) return;                   // e.g. wait until the hook banner clears
    R.micro(txt, x, y, { t0: Math.max(modeT, o.from || 0), dur: 1e9, style: 'tag', color, pointer: false, fixed: true, at: [0, 0], dimAfter: o.dimAfter === undefined ? 1.2 : o.dimAfter });
  };

  // particles draw right after the spotlight (so they stay vivid) and before text is flushed
  Retro.hooks.afterDraw.splice(1, 0, stepAndDraw);
  Retro.hooks.reset.push(() => {
    for (const P of pool) P.on = false;
    trails.clear(); streams.clear(); cursor = 0;
    tsTarget = 1; tsFrom = 1; tsT0 = 0; stepMode = false; modeT = 0; lastMode = 'real';
    R.timeScale = 1; R.simDt = 1 / 60; R.simTime = 0; R.stepMode = false;
  });
})();
