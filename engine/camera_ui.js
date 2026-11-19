/* camera_ui.js — v2 engine layer: virtual camera, cutaway peel, annotation & mechanical primitives.
 * Loaded after retro_engine.js. Everything extends the shared `R` object and stays deterministic.
 *
 *   Camera.focusOn(x, y, zoom, duration, ease)   smooth eased pan + zoom (world coords)
 *   Camera.track([{t, x, y, zoom, ease}, ...])   declarative keyframes (pure function of time)
 *   Camera.cut(x, y, zoom) / Camera.reset(dur) / Camera.setView(x, y, w, h)
 *   R.world(() => { ...draw mechanism in world coords... })   camera-transformed drawing
 *   R.peel(p, drawCasing, {mode:'wipe'|'split'|'alpha'|'lift', bbox:[x,y,w,h], dir, axis})
 *   R.arrow / R.force / R.flow                   vector & flow arrows
 *   R.label(text, x, y, {sub, color, side, at, appear})   leader-line callouts, auto-laid-out
 *                                                          inside the 900x1420 safe zone without overlaps
 *   R.telemetry / R.gauge / R.scope              HUD readouts (RPM, Hz, PSI, %, ms)
 *   R.gear / R.spring / R.hatch                  mechanical drawing helpers
 *   R.hum(voice, {freq, duty, gain, noise, wave, pan})   continuous physics-coupled audio
 */
(function () {
  'use strict';
  const Retro = window.Retro, R = Retro.R, PAL = R.PAL;
  const I = R._internal, cam = R._cam;
  const W = R.W, H = R.H, SAFE = R.SAFE;
  const rnd = Math.round;

  // ================================================================== Virtual camera
  let tween = null, keys = null;
  const easeOf = (e) => typeof e === 'function' ? e : (R.ease[e] || R.ease.inOut);
  function setCam(x, y, z) { cam.x = x; cam.y = y; cam.z = z; }
  function interp(a, b, k) {
    return { x: R.lerp(a.x, b.x, k), y: R.lerp(a.y, b.y, k), z: Math.exp(R.lerp(Math.log(a.z), Math.log(b.z), k)) };
  }
  const Camera = {
    get x() { return cam.x; }, get y() { return cam.y; }, get zoom() { return cam.z; }, get view() { return cam.view; },
    focusOn(x, y, zoom = 1, duration = 1, ease = 'inOut') {
      keys = null;
      tween = { from: { x: cam.x, y: cam.y, z: cam.z }, to: { x, y, z: zoom }, t0: R.t, dur: Math.max(1e-6, duration), ease: easeOf(ease) };
    },
    cut(x, y, zoom = 1) { keys = null; tween = null; setCam(x, y, zoom); },
    reset(duration = 0.8, ease = 'inOut') {
      Camera.focusOn(cam.view.x + cam.view.w / 2, cam.view.y + cam.view.h / 2, 1, duration, ease);
    },
    // Keyframes: [{t, x, y, zoom, ease}] — camera is a pure function of time (best for seeking/preview)
    track(list) { keys = list.slice().sort((a, b) => a.t - b.t); tween = null; },
    // Screen rectangle the world is drawn into (default: whole 270x480 canvas)
    setView(x, y, w, h) { cam.view = { x, y, w, h }; setCam(x + w / 2, y + h / 2, 1); },
    _update() {
      if (keys && keys.length) {
        const t = R.t;
        if (t <= keys[0].t) return setCam(keys[0].x, keys[0].y, keys[0].zoom || 1);
        for (let i = 0; i + 1 < keys.length; i++) {
          const a = keys[i], b = keys[i + 1];
          if (t < b.t) {
            const k = easeOf(b.ease || 'inOut')((t - a.t) / Math.max(1e-6, b.t - a.t));
            const c = interp({ x: a.x, y: a.y, z: a.zoom || 1 }, { x: b.x, y: b.y, z: b.zoom || 1 }, k);
            return setCam(c.x, c.y, c.z);
          }
        }
        const l = keys[keys.length - 1];
        return setCam(l.x, l.y, l.zoom || 1);
      }
      if (tween) {
        const k = R.clamp((R.t - tween.t0) / tween.dur, 0, 1);
        const c = interp(tween.from, tween.to, tween.ease(k));
        setCam(c.x, c.y, c.z);
        if (k >= 1) tween = null;
      }
    },
    _reset() { tween = null; keys = null; cam.view = { x: 0, y: 0, w: W, h: H }; setCam(W / 2, H / 2, 1); }
  };
  window.Camera = Camera;
  R.camera = Camera;
  Retro.hooks.afterUpdate.push(() => Camera._update());
  Retro.hooks.reset.push(() => { Camera._reset(); labels.length = 0; });
  // (reserved rects are cleared every frame in flushLabels)

  // helpers: world->screen when inside R.world, identity otherwise
  const S = (x, y) => R.inWorld() ? R.toScreen(x, y) : { x, y };

  // ================================================================== Cutaway peel
  R.peel = function (p, drawFn, o = {}) {
    p = R.clamp(p, 0, 1);
    const mode = o.mode || 'wipe';
    const ctx = I.ctx;
    if (p <= 0) { drawFn(); return; }
    if (p >= 1 && mode !== 'split') return;
    const bb = o.bbox || [0, 0, W, H];
    const a = S(bb[0], bb[1]), b = S(bb[0] + bb[2], bb[1] + bb[3]);
    const x0 = rnd(a.x), y0 = rnd(a.y), x1 = rnd(b.x), y1 = rnd(b.y);
    const e = easeOf(o.ease || 'inOut')(p);
    const edge = o.edge === undefined ? PAL.gold : o.edge;
    ctx.save();
    if (mode === 'wipe') {
      const dir = o.dir || 'right';
      let cx0 = x0, cy0 = y0, cx1 = x1, cy1 = y1, edgeLine;
      if (dir === 'right') { cx0 = rnd(x0 + (x1 - x0) * e); edgeLine = [cx0, y0, cx0, y1]; }
      else if (dir === 'left') { cx1 = rnd(x1 - (x1 - x0) * e); edgeLine = [cx1, y0, cx1, y1]; }
      else if (dir === 'down') { cy0 = rnd(y0 + (y1 - y0) * e); edgeLine = [x0, cy0, x1, cy0]; }
      else { cy1 = rnd(y1 - (y1 - y0) * e); edgeLine = [x0, cy1, x1, cy1]; }
      ctx.beginPath(); ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0); ctx.clip();
      drawFn();
      ctx.restore();
      if (edge) R.screen(() => { I.lineScreen(edgeLine[0], edgeLine[1], edgeLine[2], edgeLine[3], PAL.black, 3); I.lineScreen(edgeLine[0], edgeLine[1], edgeLine[2], edgeLine[3], edge, 1); });
      return;
    }
    if (mode === 'split') {
      const axis = o.axis || 'x', dist = o.distance === undefined ? (axis === 'x' ? (x1 - x0) : (y1 - y0)) * 0.75 : o.distance;
      const d = rnd(dist * e), mid = axis === 'x' ? rnd((x0 + x1) / 2) : rnd((y0 + y1) / 2);
      ctx.save();
      if (axis === 'x') { ctx.beginPath(); ctx.rect(x0 - 2, y0 - 2, mid - x0 + 2, y1 - y0 + 4); ctx.clip(); ctx.translate(-d, 0); }
      else { ctx.beginPath(); ctx.rect(x0 - 2, y0 - 2, x1 - x0 + 4, mid - y0 + 2); ctx.clip(); ctx.translate(0, -d); }
      drawFn(); ctx.restore();
      if (axis === 'x') { ctx.beginPath(); ctx.rect(mid, y0 - 2, x1 - mid + 2, y1 - y0 + 4); ctx.clip(); ctx.translate(d, 0); }
      else { ctx.beginPath(); ctx.rect(x0 - 2, mid, x1 - x0 + 4, y1 - mid + 2); ctx.clip(); ctx.translate(0, d); }
      drawFn(); ctx.restore();
      return;
    }
    if (mode === 'lift') ctx.translate(0, -rnd((o.distance || 40) * e));
    ctx.globalAlpha = 1 - e;
    drawFn();
    ctx.restore();
  };

  // Diagonal hatch fill — the classic "cut surface" look of engineering cutaways
  R.hatch = function (x, y, w, h, c, spacing = 3) {
    const a = S(x, y), b = S(x + w, y + h), ctx = I.ctx;
    const x0 = rnd(a.x), y0 = rnd(a.y), x1 = rnd(b.x), y1 = rnd(b.y);
    ctx.fillStyle = c;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) if (((xx + yy) % spacing + spacing) % spacing === 0) ctx.fillRect(xx, yy, 1, 1);
  };

  // ================================================================== Arrows & flows
  function arrowScreen(x0, y0, x1, y1, c, o = {}) {
    const th = o.thick || 1, head = o.head || 4;
    const ang = Math.atan2(y1 - y0, x1 - x0), ca = Math.cos(ang), sa = Math.sin(ang);
    const bx = x1 - ca * head, by = y1 - sa * head;
    const tri = [[x1 + ca, y1 + sa], [bx - sa * head * 0.8, by + ca * head * 0.8], [bx + sa * head * 0.8, by - ca * head * 0.8]];
    if (o.outline !== false) {
      I.lineScreen(x0, y0, bx, by, o.outline || PAL.black, th + 2);
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) I.fillPolyScreen(tri, o.outline || PAL.black, ox, oy);
    }
    I.lineScreen(x0, y0, bx, by, c, th);
    I.fillPolyScreen(tri, c);
  }
  // R.arrow(x0,y0,x1,y1,color,{thick, head, outline}) — endpoints in world coords inside R.world
  R.arrow = function (x0, y0, x1, y1, c, o = {}) {
    const a = S(x0, y0), b = S(x1, y1);
    R.screen(() => arrowScreen(a.x, a.y, b.x, b.y, c || PAL.coral, o));
  };
  // Force/velocity vector from a point: angle in radians, length in screen pixels (stays readable at any zoom)
  R.force = function (x, y, ang, len, c, o = {}) {
    const a = S(x, y);
    const pulse = o.pulse ? Math.round(Math.sin(R.t * 10) * 1.5) : 0;
    const L = Math.max(4, len + pulse);
    R.screen(() => arrowScreen(a.x, a.y, a.x + Math.cos(ang) * L, a.y + Math.sin(ang) * L, c || PAL.coral, o));
    if (o.label) R.screen(() => R.text(o.label, a.x + Math.cos(ang) * (L + 6), a.y + Math.sin(ang) * (L + 6) - 3, { color: c || PAL.coral, align: Math.cos(ang) < -0.3 ? 'right' : Math.cos(ang) > 0.3 ? 'left' : 'center' }));
  };
  // Animated chevrons travelling along a polyline (fluid, air, current, data)
  R.flow = function (points, c, o = {}) {
    const pts = points.map(p => S(p[0], p[1]));
    const segs = []; let total = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      segs.push({ a: pts[i], b: pts[i + 1], l, s: total }); total += l;
    }
    if (total <= 0) return;
    const spacing = o.spacing || 9, size = o.size || 2, speed = o.speed === undefined ? 24 : o.speed;
    let off = ((R.t * speed + (o.phase || 0)) % spacing + spacing) % spacing;
    const ctx = I.ctx;
    for (let d = off; d < total; d += spacing) {
      const sg = segs.find(sg => d >= sg.s && d <= sg.s + sg.l) || segs[segs.length - 1];
      const k = (d - sg.s) / sg.l, x = sg.a.x + (sg.b.x - sg.a.x) * k, y = sg.a.y + (sg.b.y - sg.a.y) * k;
      const dx = (sg.b.x - sg.a.x) / sg.l, dy = (sg.b.y - sg.a.y) / sg.l;
      const wx = x - dx * size, wy = y - dy * size;
      I.lineScreen(wx - dy * size, wy + dx * size, x, y, c || PAL.cyan, 1);
      I.lineScreen(wx + dy * size, wy - dx * size, x, y, c || PAL.cyan, 1);
    }
    void ctx;
  };

  // ================================================================== Leader-line labels (auto layout)
  const labels = [];
  const reserved = [];
  // Mark a screen rectangle (HUD tag, gauge, panel) that leader-line labels must not cover this frame
  R.reserve = function (x, y, w, h) { if (x && typeof x === 'object') ({ x, y, w, h } = x); reserved.push({ x, y, w, h }); };
  // R.label(text, anchorX, anchorY, {sub, color, side:'auto'|'left'|'right', at:[dx,dy], appear, priority, area})
  R.label = function (text, x, y, o = {}) {
    const a = S(x, y);
    const appear = o.appear === undefined ? 1 : R.clamp(o.appear, 0, 1);
    if (appear <= 0) return;
    labels.push({ text: String(text).toUpperCase(), sub: o.sub ? String(o.sub).toUpperCase() : null, ax: a.x, ay: a.y,
      color: o.color || PAL.gold, side: o.side || 'auto', at: o.at || null, appear, priority: o.priority || 0, area: o.area || SAFE, n: labels.length });
  };
  function overlap(a, b, m = 2) { return a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y; }
  function flushLabels() {
    if (!labels.length) { reserved.length = 0; return; }
    const list = labels.splice(0).sort((p, q) => (q.priority - p.priority) || (p.ay - q.ay) || (p.n - q.n));
    const placed = reserved.splice(0);
    for (const L of list) {
      const A = L.area;
      const w = Math.max(R.textWidth(L.text), L.sub ? R.textWidth(L.sub) : 0) + 8, h = L.sub ? 21 : 12;
      let x, y;
      if (L.at) { x = L.ax + L.at[0] - w / 2; y = L.ay + L.at[1] - h / 2; }
      else {
        const side = L.side === 'auto' ? (L.ax < A.x + A.w / 2 ? 'left' : 'right') : L.side;
        x = side === 'left' ? A.x + 1 : A.x + A.w - w - 1; y = L.ay - h / 2;
      }
      x = R.clamp(rnd(x), A.x, A.x + A.w - w); y = R.clamp(rnd(y), A.y, A.y + A.h - h);
      let r = { x, y, w, h }, guard = 0, flip = false;
      while (guard++ < 40) {
        const hit = placed.find(p => overlap(r, p));
        if (!hit) break;
        if (!flip) { r.y = hit.y + hit.h + 3; if (r.y + h > A.y + A.h) { flip = true; r.y = R.clamp(L.ay - h / 2, A.y, A.y + A.h - h); } }
        else { r.y = hit.y - h - 3; if (r.y < A.y) { r.y = A.y; break; } }
      }
      placed.push(r);
      drawLabel(L, r);
    }
  }
  function drawLabel(L, r) {
    const toLeft = r.x + r.w / 2 < L.ax;   // box is left of the anchor
    const ex = toLeft ? r.x + r.w : r.x, ey = r.y + Math.floor(r.h / 2);
    const inside = L.ax >= r.x && L.ax <= r.x + r.w && L.ay >= r.y && L.ay <= r.y + r.h;
    const kx = ex + (toLeft ? 5 : -5);
    const grow = R.clamp(L.appear / 0.45, 0, 1);
    if (!inside) {
      // leader: anchor -> knee -> box edge, dark-outlined for legibility
      const pts = [[L.ax, L.ay], [kx, ey], [ex, ey]];
      const total = Math.hypot(kx - L.ax, ey - L.ay) + Math.abs(ex - kx);
      let rem = total * grow;
      for (const pass of [[PAL.black, 3], [L.color, 1]]) {
        let left = rem;
        for (let i = 0; i < 2 && left > 0; i++) {
          const [p, q] = [pts[i], pts[i + 1]], l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, k = Math.min(1, left / l);
          I.lineScreen(p[0], p[1], p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, pass[0], pass[1]);
          left -= l;
        }
      }
      R.screen(() => { R.rect(L.ax - 2, L.ay - 2, 5, 5, PAL.black); R.rect(L.ax - 1, L.ay - 1, 3, 3, L.color); });
    }
    if (L.appear < 0.45) return;
    const pop = R.clamp((L.appear - 0.45) / 0.55, 0, 1);
    const dy = rnd((1 - R.ease.outBack(pop)) * 3);
    R.screen(() => {
      R.box(r.x, r.y + dy, r.w, r.h, { fill: PAL.bg, border: L.color });
      R.text(L.text, r.x + 4, r.y + dy + 3, { color: L.color, shadow: false });
      if (L.sub) R.text(L.sub, r.x + 4, r.y + dy + 12, { color: PAL.mid, shadow: false });
    });
  }
  Retro.hooks.afterDraw.push(flushLabels);

  // ================================================================== HUD telemetry
  // R.telemetry(x, y, w, [{label, value, unit, decimals, color, compact}], {title, border})
  R.telemetry = function (x, y, w, rows, o = {}) {
    R.screen(() => {
      const h = rows.length * 10 + 6 + (o.title ? 10 : 0);
      R.box(x, y, w, h, { fill: o.fill || PAL.panel, border: o.border || PAL.dim });
      let yy = y + 4;
      if (o.title) { R.text(o.title, x + 4, yy, { color: o.titleColor || PAL.white, shadow: false }); yy += 10; }
      for (const row of rows) {
        R.text(row.label, x + 4, yy, { color: PAL.mid, shadow: false });
        const v = typeof row.value === 'number' ? R.fmt(row.value, { decimals: row.decimals || 0, compact: row.compact }) : String(row.value);
        R.text(v + (row.unit ? ' ' + row.unit : ''), x + w - 4, yy, { color: row.color || PAL.cyan, align: 'right', shadow: false });
        yy += 10;
      }
    });
  };
  // Needle gauge: frac 0..1 sweeps 180°. {label, value text, color, danger: 0..1 start of red zone}
  R.gauge = function (cx, cy, r, frac, o = {}) {
    R.screen(() => {
      const c = o.color || PAL.cyan;
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI + Math.PI * i / 10, ca = Math.cos(a), sa = Math.sin(a);
        const red = o.danger !== undefined && i / 10 >= o.danger;
        I.lineScreen(cx + ca * (r - 3), cy + sa * (r - 3), cx + ca * r, cy + sa * r, red ? PAL.coral : PAL.dim, 1);
      }
      const a = Math.PI + Math.PI * R.clamp(frac, 0, 1);
      I.lineScreen(cx, cy, cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2), PAL.black, 3);
      I.lineScreen(cx, cy, cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2), c, 1);
      R.rect(cx - 1, cy - 1, 3, 3, PAL.white);
      if (o.label) R.text(o.label, cx, cy + 4, { color: PAL.mid, align: 'center' });
      if (o.value !== undefined) R.text(String(o.value), cx, cy + 13, { color: c, align: 'center' });
    });
  };
  // Oscilloscope trace: fn(phase 0..1) -> -1..1 drawn `cycles` times; great for showing the Hz you hear
  R.scope = function (x, y, w, h, fn, o = {}) {
    R.screen(() => {
      R.box(x, y, w, h, { fill: PAL.black, border: o.border || PAL.dim });
      R.hline(x + 2, y + h / 2, w - 4, PAL.panel2);
      const cyc = o.cycles || 3, c = o.color || PAL.emerald;
      let prev = null;
      for (let i = 0; i < w - 4; i++) {
        const ph = ((i / (w - 4)) * cyc + (o.phase || 0)) % 1;
        const v = R.clamp(fn(ph), -1, 1), py = y + h / 2 - v * (h / 2 - 3);
        if (prev !== null) I.lineScreen(x + 1 + i, prev, x + 2 + i, py, c, 1);
        prev = py;
      }
    });
  };

  // ================================================================== Mechanical helpers (world coords)
  // R.gear(cx, cy, r, teeth, angle, color, {depth, hole, holeColor, outline, shadow})
  R.gear = function (cx, cy, r, teeth, ang, c, o = {}) {
    const d = o.depth || Math.max(2, r * 0.2), pts = [];
    for (let i = 0; i < teeth; i++) {
      const a0 = ang + (i / teeth) * Math.PI * 2, step = Math.PI * 2 / teeth;
      for (const [f, rr] of [[0.0, r - d], [0.18, r], [0.5, r], [0.68, r - d]]) {
        const a = a0 + f * step; pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
      }
    }
    R.poly(pts, c, { outline: o.outline === undefined ? PAL.black : o.outline, outlineW: o.outlineW || 1, shadow: o.shadow });
    if (o.hole) R.circle(cx, cy, o.hole, o.holeColor || PAL.bg);
    if (o.marker !== false) R.line(cx, cy, cx + Math.cos(ang) * (r - d - 1), cy + Math.sin(ang) * (r - d - 1), o.markerColor || PAL.black, 1);
  };
  // Zig-zag spring between two points
  R.spring = function (x0, y0, x1, y1, coils, width, c, th = 1) {
    const L = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / L, uy = (y1 - y0) / L, nx = -uy, ny = ux;
    const pts = [[x0, y0]], n = coils * 2;
    for (let i = 1; i < n; i++) { const k = i / n, s = (i % 2 ? 1 : -1) * width / 2; pts.push([x0 + ux * L * k + nx * s, y0 + uy * L * k + ny * s]); }
    pts.push([x1, y1]);
    R.polyline(pts, c, th);
  };

  // ================================================================== Continuous physics-coupled audio
  // Call every frame while the sound should play; frames without a call fade the voice out.
  R.hum = function (voice, o = {}) {
    window.logSynthState(R.frame, o.freq || 110, o.duty === undefined ? 0.5 : o.duty, o.gain === undefined ? 0.3 : o.gain,
      o.noise || 0, { voice, wave: o.wave || 'square', pan: o.pan || 0 });
  };
})();
